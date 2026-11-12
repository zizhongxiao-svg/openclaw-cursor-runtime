// Cursor SDK transport for the OpenClaw cursor-cli backend (default).
//
// Each OpenClaw session maps to one long-lived local Cursor agent (`agentId` is the
// CLI session id OpenClaw stores). Agents are cached in memory and closed after a
// long idle period or at process exit; Agent.resume reopens them on demand.
//
// OpenClaw tools: every turn OpenClaw hands the CLI a --mcp-config file pointing
// at its loopback MCP server with that turn's grant (Bearer token + capture key).
// Cursor team policies may block MCP servers, so instead of giving Cursor an MCP
// server, the turn's OpenClaw tools are registered as SDK `customTools`; each
// call is forwarded to the loopback server with that turn's credentials. The tool
// surface and authority are therefore exactly what claude-cli gets.
import { subscribe } from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { threadId } from "node:worker_threads";
import { extractMcpConfigPaths } from "./mcp-relay.js";
import { CURSOR_NATIVE_TOOL_NAMES, observeNativeTool } from "./tool-policy.js";
import { SessionState, buildCompactionPrompt, wrapWithSeed } from "./session-state.js";
import {
  EFFORTS,
  THINKING_TO_EFFORT,
  PACKAGE_VERSION,
  buildPromptText,
  extractImagePaths,
  readApiKey,
  readImages,
} from "./common.js";

export { IMAGE_ARG } from "./common.js";

const TOOL_CALL_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_AGENT_IDLE_MS = 6 * 60 * 60 * 1000;
const MESSAGING_TOOLS = new Set(["message", "sessions_send", "conversations_send"]);
const SILENT_TOKEN = "NO_REPLY";

// OpenClaw can load (register) the plugin more than once in one gateway thread, each
// load getting its own copy of this module. Module-level caches then split: a turn
// served by the other copy re-imports the SDK, re-opens the Cursor agent and re-lists
// tools (seen as sdk=700 tools=1000+ agent=4000+ right after a warm turn). Keep the
// caches on globalThis, keyed by package version, so every copy shares one set.
const SHARED_KEY = Symbol.for(`openclaw-cursor-runtime.shared@${PACKAGE_VERSION}`);
const shared = (globalThis[SHARED_KEY] ??= { sdkPromise: undefined, agentCacheV2: undefined, toolCache: undefined, state: undefined, prewarm: undefined, loads: 0 });
shared.loads += 1;
/** Which copy of this module served a turn (logged so duplicate loads stay visible). */
const MODULE_INSTANCE = shared.loads;

function loadSdk(opts) {
  if (opts.sdk) return Promise.resolve(opts.sdk);
  if (!shared.sdkPromise) {
    shared.sdkPromise = import("@cursor/sdk")
      .then((sdk) => {
        // Process-wide: the first loaded config decides (changing it needs a gateway restart).
        if (opts.useHttp1 !== false) sdk.Cursor.configure({ local: { useHttp1ForAgent: true } });
        return sdk;
      })
      .catch((err) => {
        shared.sdkPromise = undefined; // allow a later turn to retry the import
        throw err;
      });
  }
  return shared.sdkPromise;
}

// The SDK silently retries a Cursor stream that receives nothing for 30 s, after 2, 4, 8,
// 16 s... of backoff: four silent attempts add ~150 s before the first event. Over HTTP/1.1
// each attempt is one RunSSE request tagged with the run's request id, so count them
// ("created", not "start": a tunnel that never connects never starts its request).
const RUN_STREAM_PATH = "/agent.v1.AgentService/RunSSE";
function streamAttemptCounts() {
  if (!shared.streamAttempts) {
    const counts = new Map();
    shared.streamAttempts = counts;
    try {
      subscribe("http.client.request.created", ({ request }) => {
        try {
          if (!String(request?.path).endsWith(RUN_STREAM_PATH)) return;
          const id = request.getHeader("x-original-request-id");
          if (typeof id !== "string") return;
          counts.set(id, (counts.get(id) ?? 0) + 1);
          if (counts.size > 256) counts.delete(counts.keys().next().value);
        } catch {}
      });
    } catch {}
  }
  return shared.streamAttempts;
}

/**
 * OpenClaw model id -> Cursor SDK ModelSelection.
 * `claude-opus-5-5-medium` -> { id: "claude-opus-5-5", params: [context=300k, effort=medium, fast=false] }.
 * A thinking level, when given, overrides the effort.
 */
export function resolveModelSelection(modelId, thinkingLevel, defaults = {}) {
  let id = String(modelId ?? "").trim();
  let effort;
  const parts = id.split("-");
  if (parts.length > 1 && EFFORTS.has(parts.at(-1))) { effort = parts.pop(); id = parts.join("-"); }
  if (THINKING_TO_EFFORT[thinkingLevel]) effort = THINKING_TO_EFFORT[thinkingLevel];
  if (!id || id === "auto" || id === "default") return { id: "auto" };
  const claude = id.startsWith("claude-");
  effort ??= defaults.effort ?? (claude ? "medium" : undefined);
  const params = [];
  const context = defaults.context ?? (claude ? "300k" : undefined);
  if (context) params.push({ id: "context", value: context });
  if (effort) params.push({ id: "effort", value: effort });
  if (claude) params.push({ id: "fast", value: "false" });
  return params.length ? { id, params } : { id };
}

/** One-line description of a model selection for logs, e.g. "claude-opus-5-5 effort=high context=300k". */
export function describeModelSelection(model) {
  return [model.id, ...(model.params ?? []).filter((p) => p.id !== "fast").map((p) => `${p.id}=${p.value}`)].join(" ");
}

function readLoopback(args, log) {
  const files = extractMcpConfigPaths(args);
  for (const file of files) {
    try {
      const server = JSON.parse(readFileSync(file, "utf8"))?.mcpServers?.openclaw;
      if (server && typeof server.url === "string") return { url: server.url, headers: server.headers ?? {} };
    } catch (err) {
      log?.(`cursor-cli: cannot read MCP config ${file}: ${err.message}`);
    }
  }
  if (files.length) throw new Error("OpenClaw MCP configuration is unavailable; refusing to run without the requested tools");
  return undefined;
}

/** Minimal JSON-RPC client for OpenClaw's loopback MCP server (JSON or SSE replies). */
class LoopbackClient {
  constructor({ url, headers }, signal) {
    this.url = url;
    this.headers = headers;
    this.signal = signal;
    this.nextId = 0;
  }

  async rpc(method, params, timeoutMs = 120000) {
    const id = ++this.nextId;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`OpenClaw MCP ${method} timed out`)), timeoutMs);
    const onAbort = () => ctl.abort(this.signal.reason);
    if (this.signal?.aborted) onAbort();
    else this.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: ctl.signal,
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`OpenClaw MCP ${method} HTTP ${res.status}: ${body.slice(0, 300)}`);
      let msg;
      if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        for (const line of body.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try { const m = JSON.parse(line.slice(5)); if (m.id === id) msg = m; } catch {}
        }
      } else {
        const parsed = body ? JSON.parse(body) : undefined;
        msg = Array.isArray(parsed) ? parsed.find((m) => m.id === id) : parsed;
      }
      if (!msg) throw new Error(`OpenClaw MCP ${method}: empty response`);
      if (msg.error) throw Object.assign(new Error(`OpenClaw MCP ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`), { code: msg.error.code });
      return msg.result;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", onAbort);
    }
  }

  async listTools() {
    try {
      await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openclaw-cursor-runtime", version: PACKAGE_VERSION } });
    } catch (err) {
      // Older stateless loopback servers may only implement tools/list and tools/call.
      if (err.code !== -32601) throw err;
    }
    const tools = [];
    let cursor;
    do {
      const r = await this.rpc("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(r?.tools)) throw new Error("OpenClaw MCP tools/list returned an invalid tool list");
      tools.push(...r.tools);
      cursor = r?.nextCursor;
    } while (cursor);
    return tools;
  }
}

function toSdkToolResult(result) {
  const content = [];
  for (const block of result?.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
    else if (block?.type === "image" && typeof block.data === "string") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    else if (block) content.push({ type: "text", text: JSON.stringify(block) });
  }
  if (!content.length && result?.structuredContent) content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  return { content: content.length ? content : [{ type: "text", text: "" }], isError: result?.isError === true };
}

/**
 * OpenClaw expects the bare silent token when the agent already replied through a
 * messaging tool. Cursor models sometimes append commentary after it, or end with no
 * text at all; normalise those cases (only after a successful messaging tool call, so a
 * real answer that happens to start with the token is kept).
 */
export function normalizeFinalText(text, { messagedThisTurn = false } = {}) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === SILENT_TOKEN) return SILENT_TOKEN;
  if (messagedThisTurn && (!trimmed || trimmed.startsWith(`${SILENT_TOKEN} `) || trimmed.startsWith(`${SILENT_TOKEN}\n`))) return SILENT_TOKEN;
  return text;
}

/**
 * Cache of OpenClaw tool definitions (name/description/schema only, never credentials).
 * Listing ~50 tools from the loopback server took 6-12 s per turn, so a cached list is
 * used right away and refreshed in the background with the current turn's grant. Every
 * call still goes through that turn's grant, so OpenClaw keeps enforcing permissions.
 */
export class ToolListCache {
  constructor({ maxEntries = 32 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = new Map(); // key -> tools[]
    this.refreshing = new Set();
  }

  static key(cwd, allow) {
    return `${cwd}\u0000${allow ? [...allow].sort().join(",") : "*"}`;
  }

  /** @returns {Promise<{ tools: object[], cached: boolean }>} */
  async get(key, list, log) {
    const cached = this.entries.get(key);
    if (cached) {
      if (!this.refreshing.has(key)) {
        this.refreshing.add(key);
        list()
          .then((tools) => this.store(key, tools))
          .catch((err) => log?.(`cursor-cli: background tool list refresh failed: ${err.message}`))
          .finally(() => this.refreshing.delete(key));
      }
      return { tools: cached, cached: true };
    }
    const tools = await list();
    this.store(key, tools);
    return { tools, cached: false };
  }

  store(key, tools) {
    if (!Array.isArray(tools)) return;
    this.entries.delete(key);
    this.entries.set(key, tools);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    this.onStore?.(key, tools);
  }

  /** Load lists saved by a previous gateway run and save later updates to `state`. */
  persistTo(state) {
    if (this.persisted === state) return;
    this.persisted = state;
    for (const [key, tools] of state.allTools()) if (!this.entries.has(key) && Array.isArray(tools)) this.entries.set(key, tools);
    this.onStore = (key, tools) => state.setTools(key, tools);
  }
}

const sharedToolCache = (shared.toolCache ??= new ToolListCache());

/** Build SDK customTools that forward to the turn's OpenClaw loopback MCP server. */
async function buildCustomTools(client, log, onCall, allow, { cache, cacheKey, onList, onToolTiming } = {}) {
  let tools;
  try {
    if (cache && cacheKey) {
      const r = await cache.get(cacheKey, () => client.listTools(), log);
      tools = r.tools;
      onList?.(r.cached);
    } else {
      tools = await client.listTools();
      onList?.(false);
    }
  } catch (err) {
    log?.(`cursor-cli: OpenClaw tools unavailable this turn: ${err.message}`);
    throw new Error(`OpenClaw tools unavailable; refusing to run without the requested tools: ${err.message}`, { cause: err });
  }
  const customTools = {};
  for (const tool of tools) {
    if (!tool?.name) continue;
    if (allow && !allow.has(tool.name)) continue;
    customTools[tool.name] = {
      description: tool.description ?? `OpenClaw tool ${tool.name}`,
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      execute: async (args) => {
        const started = performance.now();
        try {
          const out = toSdkToolResult(await client.rpc("tools/call", { name: tool.name, arguments: args ?? {} }, TOOL_CALL_TIMEOUT_MS));
          if (!out.isError) onCall?.(tool.name, args ?? {});
          return out;
        } catch (err) {
          return { content: [{ type: "text", text: `OpenClaw tool ${tool.name} failed: ${err.message}` }], isError: true };
        } finally {
          onToolTiming?.(performance.now() - started);
        }
      },
    };
  }
  return Object.keys(customTools).length ? customTools : undefined;
}

export function toClaudeUsage(u) {
  if (!u) return undefined;
  // Cursor's inputTokens already includes cache reads/writes; Claude's input_tokens
  // excludes them (OpenClaw adds the cache fields back), so subtract to avoid double counting.
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  return {
    input_tokens: Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite),
    output_tokens: u.outputTokens ?? 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

/**
 * Cursor reports one usage total per run, summed over every model call in it
 * (each tool round trip re-sends the context). OpenClaw derives the session's
 * context size from the last call, so estimate one call's share.
 */
export function estimatePerCallUsage(usage, modelCalls) {
  if (!usage) return undefined;
  const n = Math.max(1, Math.floor(modelCalls || 1));
  if (n === 1) return usage;
  const div = (v) => Math.round((v ?? 0) / n);
  return {
    input_tokens: div(usage.input_tokens),
    output_tokens: div(usage.output_tokens),
    cache_read_input_tokens: div(usage.cache_read_input_tokens),
    cache_creation_input_tokens: div(usage.cache_creation_input_tokens),
  };
}

/** message(action:send, final:true): the agent's terminal answer to the chat. */
export function isFinalMessageCall(name, args) {
  if (name !== "message" || !args || args.final !== true) return false;
  return args.action === undefined || args.action === "send";
}

/** Cursor auth failures that a fresh token exchange can fix. */
export function isRetryableAuthError(message) {
  return /authentication error|unauthenticated|\b401\b|log(?:ging)? out and back in|token (?:has )?expired/i.test(String(message ?? ""));
}

/** In-memory cache of open SDK agents, keyed by agent id and working directory. */
export class AgentCache {
  constructor({ idleMs = DEFAULT_AGENT_IDLE_MS, now = () => Date.now() } = {}) {
    this.idleMs = idleMs;
    this.now = now;
    this.entries = new Map(); // key -> { agent, lastUsed, busy }
    this.queues = new Map();
    this.compactions = new Map();
    this.timer = undefined;
  }

  key(agentId, cwd) {
    return `${agentId}\u0000${cwd}`;
  }

  get(agentId, cwd) {
    const e = this.entries.get(this.key(agentId, cwd));
    if (e?.unsettled) throw e.unsettled;
    if (e) e.lastUsed = this.now();
    return e?.agent;
  }

  async lock(agentId, cwd, signal) {
    const key = this.key(agentId, cwd);
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    this.queues.set(key, tail);
    tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key); });
    try {
      await waitWithSignal(previous, signal);
      return release;
    } catch (err) {
      // An aborted waiter must not let later work bypass the current owner.
      release();
      throw err;
    }
  }

  markUnsettled(agentId, cwd, error, settlement) {
    const e = this.entries.get(this.key(agentId, cwd));
    if (!e) return;
    e.unsettled = error;
    settlement.then(() => {
      if (e.unsettled === error) delete e.unsettled;
    }, () => {}); // The owning turn reports the failure; unsafe agents stay unavailable.
  }

  set(agent, cwd) {
    this.entries.set(this.key(agent.agentId, cwd), { agent, lastUsed: this.now(), busy: 0 });
    this.arm();
  }

  acquire(agentId, cwd) {
    const e = this.entries.get(this.key(agentId, cwd));
    if (e) { e.busy += 1; e.lastUsed = this.now(); }
  }

  release(agentId, cwd) {
    const e = this.entries.get(this.key(agentId, cwd));
    if (e) { e.busy = Math.max(0, e.busy - 1); e.lastUsed = this.now(); }
  }

  delete(agentId, cwd) {
    const k = this.key(agentId, cwd);
    const e = this.entries.get(k);
    this.entries.delete(k);
    try { e?.agent.close(); } catch {}
  }

  /** Like delete(), but waits until the SDK has released the agent's local executor. */
  async deleteAndDispose(agentId, cwd) {
    const k = this.key(agentId, cwd);
    const e = this.entries.get(k);
    this.entries.delete(k);
    if (e) await disposeAgent(e.agent);
  }

  /** Close agents idle longer than idleMs (they are reopened with Agent.resume on demand). */
  sweep() {
    const cutoff = this.now() - this.idleMs;
    for (const [k, e] of this.entries) {
      if (e.busy === 0 && !e.unsettled && e.lastUsed < cutoff) {
        this.entries.delete(k);
        try { e.agent.close(); } catch {}
      }
    }
    if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  /** Change the idle limit (re-arms the sweep timer at the new interval). */
  setIdleMs(idleMs) {
    if (idleMs === this.idleMs) return;
    this.idleMs = idleMs;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.entries.size) this.arm();
  }

  closeAll() {
    for (const e of this.entries.values()) try { e.agent.close(); } catch {}
    this.entries.clear();
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  arm() {
    if (this.timer || !Number.isFinite(this.idleMs) || this.idleMs <= 0) return;
    this.timer = setInterval(() => this.sweep(), Math.min(this.idleMs, 10 * 60 * 1000));
    this.timer.unref?.();
  }
}

// Same-version reloads must not reuse pre-locking cache instances. Keep the other
// shared state, including compaction aliases that may not have flushed to disk.
if (!shared.agentCacheV2) {
  shared.agentCacheV2 = new AgentCache();
  const cache = shared.agentCacheV2;
  process.once("exit", () => cache.closeAll());
}
const sharedCache = shared.agentCacheV2;

/**
 * Close an agent and wait for the SDK to release its local executor. The SDK shares one
 * executor per (cwd, API key, settings) and caches the exchanged access token inside it;
 * agent.close() returns before the executor is released, so an immediate Agent.resume
 * would get the same executor and its expired token back.
 */
async function disposeAgent(agent) {
  try {
    if (typeof agent?.[Symbol.asyncDispose] === "function") await agent[Symbol.asyncDispose]();
    else agent?.close?.();
  } catch {}
}

function abortError(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("Cursor turn was aborted");
}

const COMPACTION_WAIT_MS = 3 * 60 * 1000;
// OpenClaw gives a plugin iterator 5 s to close.
const CANCEL_GRACE_MS = 4000;

function waitWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    const settle = (fn, value) => {
      signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    Promise.resolve(promise).then((value) => settle(resolve, value), (err) => settle(reject, err));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function lockSession(cache, state, agentId, cwd, signal) {
  for (;;) {
    const current = state.resolve(agentId);
    const release = await cache.lock(current, cwd, signal);
    if (state.resolve(agentId) === current) return { agentId: current, release };
    // A compaction changed the id while this waiter was queued.
    release();
  }
}

function reportUnsettled(cache, agentId, cwd, log) {
  return (cause, settlement) => {
    const error = new Error(`Cursor agent ${agentId} is still settling; refusing to reuse it: ${cause.message}`, { cause });
    cache.markUnsettled(agentId, cwd, error, settlement);
    log?.(`cursor-cli: ${error.message}`);
    return error;
  };
}

async function sendRun(agent, message, options, signal, onUnsettled) {
  if (signal.aborted) throw abortError(signal);
  const pending = Promise.resolve().then(() => agent.send(message, options));
  try {
    return await waitWithSignal(pending, signal);
  } catch (err) {
    if (signal.aborted) {
      // The SDK has no abort input for send(). Cancel a late handle before reuse.
      const settlement = pending.then(async (run) => {
        await run.cancel();
        await run.wait();
      }, () => {});
      onUnsettled(abortError(signal), settlement);
    }
    throw err;
  }
}

function controlRun(run, signal, onUnsettled) {
  let iterator;
  let finished = false;
  let stopping;
  const stop = () => {
    if (!stopping) {
      const settlement = Promise.resolve().then(() => run.cancel()).then(() => run.wait());
      stopping = waitWithSignal(settlement, AbortSignal.timeout(CANCEL_GRACE_MS))
        .catch((err) => { throw onUnsettled(err, settlement); });
    }
    return stopping;
  };
  const onAbort = () => { stop().catch(() => {}); }; // close() awaits and reports it.
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return {
    async *stream() {
      iterator = run.stream();
      for (;;) {
        const next = await waitWithSignal(iterator.next(), signal);
        if (next.done) return;
        yield next.value;
      }
    },
    async wait() {
      const result = await waitWithSignal(run.wait(), signal);
      finished = true;
      return result;
    },
    stop,
    async close() {
      signal.removeEventListener("abort", onAbort);
      if (!finished || stopping) await stop();
      await iterator?.return?.();
    },
  };
}

/** The shared persistent state (first caller decides the file; tests pass their own). */
function resolveState(opts) {
  if (opts.state) return opts.state;
  shared.state ??= new SessionState({ file: opts.stateFile });
  return shared.state;
}

/** Context window of a model selection in tokens ("300k" -> 300000, "1m" -> 1000000). */
export function contextWindowTokens(model) {
  const v = String(model?.params?.find((p) => p.id === "context")?.value ?? "").trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(v);
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1000 : 1));
}

/** Token count past which a turn triggers background compaction (0: never). */
export function autoCompactThreshold(model, { tokens = 0, percent = 0 } = {}) {
  if (tokens > 0) return tokens;
  const window = contextWindowTokens(model);
  return percent > 0 && window ? Math.floor((window * percent) / 100) : 0;
}

/** Context sent with one model call of this turn, from the per-call usage estimate. */
export function contextTokens(perCall) {
  if (!perCall) return undefined;
  return (perCall.input_tokens ?? 0) + (perCall.cache_read_input_tokens ?? 0) + (perCall.cache_creation_input_tokens ?? 0);
}

/**
 * Compact a Cursor agent the way Claude Code's /compact does, using what the SDK offers:
 * ask the agent for a continuation summary, open a fresh agent, and record the summary
 * as its first-turn seed plus an alias old id -> new id. The old agent is closed.
 * Concurrent turns and compactions share the cache's per-session queue.
 * @returns {Promise<{ agentId: string, summaryChars: number }>}
 */
export function compactAgent(options) {
  const { cache, state, agentId, cwd, abortSignal, delayMs = 0 } = options;
  const key = cache.key(state.resolve(agentId), cwd);
  const pending = cache.compactions.get(key);
  if (pending) return waitWithSignal(pending, abortSignal);
  const job = (async () => {
    const lock = await lockSession(cache, state, agentId, cwd, abortSignal);
    try {
      if (delayMs > 0) await delay(delayMs, undefined, { signal: abortSignal, ref: false });
      return await performCompaction({ ...options, agentId: lock.agentId });
    } finally {
      lock.release();
    }
  })();
  cache.compactions.set(key, job);
  const forget = () => { if (cache.compactions.get(key) === job) cache.compactions.delete(key); };
  job.then(forget, forget);
  return job;
}

async function performCompaction({ sdk, cache, state, agentId, cwd, model, apiKey, instructions, log, abortSignal }) {
  const signal = AbortSignal.any([AbortSignal.timeout(COMPACTION_WAIT_MS), ...(abortSignal ? [abortSignal] : [])]);
  if (signal.aborted) throw abortError(signal);
  let agent = cache.get(agentId, cwd);
  const seed = state.seed(agentId);
  if (seed) return { agentId, summaryChars: seed.length };
  const t0 = Date.now();
  const local = { cwd, settingSources: [] };
  if (!agent) { agent = await sdk.Agent.resume(agentId, { apiKey, model, local }); cache.set(agent, cwd); }
  cache.acquire(agentId, cwd);
  try {
    const onUnsettled = reportUnsettled(cache, agentId, cwd, log);
    const run = await sendRun(agent, buildCompactionPrompt(instructions), { model, mode: "plan", local: {} }, signal, onUnsettled);
    const control = controlRun(run, signal, onUnsettled);
    let summary;
    try {
      let streamed = "";
      for await (const m of control.stream()) {
        if (m.type !== "assistant") continue;
        for (const block of m.message?.content ?? []) if (block?.type === "text" && block.text) streamed += block.text;
      }
      const result = await control.wait();
      if (result.status !== "finished") throw new Error(`summary run ${result.status}${result.error?.message ? `: ${result.error.message}` : ""}`);
      summary = String(typeof result.result === "string" && result.result ? result.result : streamed).trim();
    } finally {
      await control.close();
    }
    if (signal.aborted) throw abortError(signal);
    if (summary.length < 200) throw new Error(`summary too short (${summary.length} chars)`);
    const fresh = await sdk.Agent.create({ apiKey, model, local, name: "openclaw" });
    if (signal.aborted) {
      await disposeAgent(fresh);
      throw abortError(signal);
    }
    cache.set(fresh, cwd);
    state.setSeed(fresh.agentId, summary);
    state.setAlias(agentId, fresh.agentId);
    state.noteAgent(fresh.agentId, cwd, model);
    state.flush();
    cache.delete(agentId, cwd);
    log?.(`cursor-cli: compacted agent=${agentId} -> ${fresh.agentId} summary=${summary.length} chars in ${Date.now() - t0} ms`);
    return { agentId: fresh.agentId, summaryChars: summary.length };
  } finally {
    cache.release(agentId, cwd);
  }
}

/**
 * Startup prewarm: load the SDK and reopen recently used Cursor agents, so the first turn
 * after a gateway restart does not pay for them. Tool lists come back from the state file
 * when the tool cache is attached to it. Runs once per process.
 */
export function prewarmSdk(opts = {}) {
  if (shared.prewarm) return shared.prewarm;
  shared.prewarm = (async () => {
    const t0 = Date.now();
    const sdk = await loadSdk(opts);
    const state = resolveState(opts);
    const cache = opts.cache ?? sharedCache;
    const apiKey = readApiKey(process.env, opts.apiKeyFile, opts.log);
    const maxAge = opts.agentIdleMs !== undefined && opts.agentIdleMs > 0 ? opts.agentIdleMs : DEFAULT_AGENT_IDLE_MS;
    let opened = 0;
    for (const a of state.recentAgents(maxAge, opts.prewarmAgents ?? 8)) {
      if (cache.get(a.agentId, a.cwd)) continue;
      try {
        const agent = await sdk.Agent.resume(a.agentId, { apiKey, model: a.model, local: { cwd: a.cwd, settingSources: [] } });
        if (!cache.get(a.agentId, a.cwd)) cache.set(agent, a.cwd);
        else try { agent.close(); } catch {}
        opened += 1;
      } catch (err) {
        state.forgetAgent(a.agentId);
        opts.log?.(`cursor-cli: prewarm could not reopen agent=${a.agentId}: ${err.message}`);
      }
    }
    opts.log?.(`cursor-cli: prewarm done agents=${opened} toolLists=${state.allTools().length} in ${Date.now() - t0} ms`);
    return { agents: opened };
  })().catch((err) => {
    opts.log?.(`cursor-cli: prewarm failed: ${err.message}`);
    return { agents: 0, error: err.message };
  });
  return shared.prewarm;
}

/**
 * Build the plugin-owned execute transport. Yields claude-stream-json records.
 * @param {{ apiKeyFile?: string, useHttp1?: boolean, modelDefaults?: { context?: string },
 *           agentIdleMs?: number, sdk?: object, cache?: AgentCache, log?: (m: string) => void }} opts
 *   `sdk` and `cache` are injection points for tests.
 */
export function createSdkExecute(opts = {}) {
  // A configured idle limit tunes the shared cache; a private cache per backend build
  // would split agents across loads (each load re-opening the same Cursor agent).
  if (!opts.cache && opts.agentIdleMs !== undefined) sharedCache.setIdleMs(opts.agentIdleMs);
  const cache = opts.cache ?? sharedCache;
  const state = resolveState(opts);
  const toolCache = opts.toolListCache === false ? undefined : (opts.toolListCache ?? sharedToolCache);
  if (toolCache && (opts.state || opts.stateFile)) toolCache.persistTo(state);
  // Automatic compaction, as Claude Code does it: when one model call fills
  // autoCompactPercent of the context window. autoCompactTokens, when set, is an absolute
  // threshold instead. Neither set (or 0): only /compact.
  const autoCompactTokens = Number.isFinite(opts.autoCompactTokens) && opts.autoCompactTokens > 0 ? opts.autoCompactTokens : 0;
  const autoCompactPercent = Number.isFinite(opts.autoCompactPercent) && opts.autoCompactPercent > 0 ? Math.min(opts.autoCompactPercent, 100) : 0;

  return async function* execute(ctx) {
    const t0 = performance.now();
    const timing = {};
    const elapsed = () => Math.round(performance.now() - t0);
    const mark = (key) => { timing[key] ??= elapsed(); };
    let phase = "setup";
    let failurePhase;
    let outcome = "interrupted";
    const measure = async (name, work) => {
      const previous = phase;
      phase = name;
      const started = performance.now();
      try {
        return await work();
      } catch (err) {
        failurePhase ??= name;
        throw err;
      } finally {
        const key = `${name}Ms`;
        timing[key] = (timing[key] ?? 0) + performance.now() - started;
        phase = previous;
      }
    };
    const turnAbort = new AbortController();
    const onAbort = () => { mark("abort"); turnAbort.abort(ctx.abortSignal?.reason); };
    if (ctx.abortSignal?.aborted) onAbort();
    else ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });

    const cwd = ctx.cwd || process.cwd();
    const sideQuestion = ctx.executionMode === "side-question";
    const compactCommand = !sideQuestion ? /^\/compact(?:\s+([\s\S]*))?$/.exec(String(ctx.prompt ?? "").trim()) : null;
    let agent;
    let agentId;
    let acquired = false;
    let releaseSession;
    let completed = false;
    let compactAfter; // set when this turn's context crossed autoCompactTokens
    let agentMode = "none";
    const operation = compactCommand ? "compact" : sideQuestion ? "side-question" : "turn";
    let toolCount = 0;
    let pluginRetries = 0;
    let usageEvents = 0;
    let mcpCalls = 0;
    let ctxTokens;
    let finalDelivered = false;
    const toolCalls = new Set();
    const toolResults = new Set();
    const steps = new Set();
    const stepDurations = new Map();
    const streamAttempts = streamAttemptCounts();
    const runIds = []; // request ids of this turn's Cursor runs
    try {
      if (turnAbort.signal.aborted) throw abortError(turnAbort.signal);
      const sdk = await measure("sdk", () => loadSdk(opts));
      mark("sdk");
      const apiKey = readApiKey({ ...process.env, ...ctx.env }, opts.apiKeyFile, opts.log);
      const model = resolveModelSelection(ctx.modelId, ctx.thinkingLevel, {
        ...opts.modelDefaults,
        ...(ctx.contextWindowOption ? { context: ctx.contextWindowOption } : {}),
      });
      const local = { cwd, settingSources: [] };
      let messagedThisTurn = false;
      // Set when the agent delivered its terminal answer with message(final:true). After
      // that the only expected step is a bare NO_REPLY, so the turn can end right away.
      const onToolCall = (name, args) => {
        if (MESSAGING_TOOLS.has(name)) messagedThisTurn = true;
        if (isFinalMessageCall(name, args)) { finalDelivered = true; mark("delivered"); }
      };
      const customTools = await measure("tools", () => {
        const loopback = sideQuestion || compactCommand ? undefined : readLoopback(ctx.args, opts.log);
        return loopback ? buildCustomTools(new LoopbackClient(loopback, turnAbort.signal), opts.log, onToolCall, ctx.openClawAllow, {
            cache: toolCache,
            cacheKey: ToolListCache.key(cwd, ctx.openClawAllow),
            onList: (cached) => { timing.toolsCached = cached; },
            onToolTiming: (ms) => { mcpCalls += 1; timing.mcpCallMs = (timing.mcpCallMs ?? 0) + ms; },
          })
          : undefined;
      });
      toolCount = customTools ? Object.keys(customTools).length : 0;
      mark("tools");
      if (turnAbort.signal.aborted) throw abortError(turnAbort.signal);

      let isNew = true;
      ctx.assertCurrent?.();
      let sessionId = ctx.useResume ? ctx.sessionId : undefined;
      if (!sideQuestion && sessionId) {
        const lock = await measure("queue", () => lockSession(cache, state, sessionId, cwd, turnAbort.signal));
        releaseSession = lock.release;
        if (lock.agentId !== sessionId) opts.log?.(`cursor-cli: session ${sessionId} continues on compacted agent=${lock.agentId}`);
        sessionId = lock.agentId;
      }
      if (!sideQuestion && sessionId) {
        agent = cache.get(sessionId, cwd);
        if (agent) { isNew = false; agentMode = "cached"; timing.openMs = 0; }
        else {
          agentMode = "resumed";
          try {
            agent = await measure("open", () => sdk.Agent.resume(sessionId, { apiKey, model, local }));
            cache.set(agent, cwd);
            isNew = false;
          } catch (err) {
            throw new Error(`Cursor session ${sessionId} could not be resumed; preserving its history instead of starting an empty agent: ${err.message}`, { cause: err });
          }
        }
      }
      if (!agent) {
        agentMode = "created";
        agent = await measure("open", () => sdk.Agent.create({ apiKey, model, local, name: sideQuestion ? "openclaw side question" : "openclaw", ...(sideQuestion ? { mode: "plan" } : {}) }));
        if (!sideQuestion) cache.set(agent, cwd);
      }
      agentId = agent.agentId;
      if (!sideQuestion && !releaseSession) releaseSession = await measure("queue", () => cache.lock(agentId, cwd, turnAbort.signal));
      if (turnAbort.signal.aborted) throw abortError(turnAbort.signal);
      if (!sideQuestion) { cache.acquire(agentId, cwd); acquired = true; state.noteAgent(agentId, cwd, model); }
      mark("agent");

      // OpenClaw's /compact for a backend that owns compaction (see manualCompaction in
      // index.js): the prompt is the control command itself.
      if (compactCommand && isNew) {
        // No earlier conversation to compact (the session had no resumable agent).
        yield { type: "system", subtype: "init", session_id: agentId, model: model.id, cwd, tools: [...CURSOR_NATIVE_TOOL_NAMES] };
        outcome = "success";
        mark("result");
        yield { type: "result", subtype: "success", is_error: false, result: "", compact_result: "success", session_id: agentId };
        return;
      }
      if (compactCommand) {
        cache.release(agentId, cwd); acquired = false;
        const done = await measure("compact", () => performCompaction({ sdk, cache, state, agentId, cwd, model, apiKey, instructions: compactCommand[1], log: opts.log, abortSignal: turnAbort.signal }));
        yield { type: "system", subtype: "init", session_id: done.agentId, model: model.id, cwd, tools: [...CURSOR_NATIVE_TOOL_NAMES] };
        yield { type: "system", subtype: "compact_boundary", session_id: done.agentId, compact_metadata: { trigger: "manual", pre_agent: agentId } };
        outcome = "success";
        mark("result");
        yield { type: "result", subtype: "success", is_error: false, result: "", compact_result: "success", session_id: done.agentId };
        return;
      }

      // First turn of a successor agent: the old conversation arrives as its summary.
      const seed = sideQuestion ? undefined : state.seed(agentId);
      if (seed) isNew = true;
      // Makes /think observable: the effort actually sent to Cursor for this turn.
      opts.log?.(`cursor-cli: ${sideQuestion ? "side question" : "turn"} agent=${agentId} ${describeModelSelection(model)} think=${ctx.thinkingLevel ?? "default"}${isNew ? (seed ? " seeded-agent" : " new-agent") : ""}`);

      // claude-stream-json init: `tools` feeds OpenClaw's native tool authority projection.
      yield { type: "system", subtype: "init", session_id: agentId, model: model.id, cwd, tools: sideQuestion ? [] : [...CURSOR_NATIVE_TOOL_NAMES] };

      const text = buildPromptText({ systemPrompt: ctx.systemPrompt, prompt: seed ? wrapWithSeed(seed, ctx.prompt) : ctx.prompt, promptContext: ctx.promptContext, isNew });
      const images = readImages(extractImagePaths(ctx.args), opts.log);
      const message = images.length ? { text, images } : text;
      const sendOptions = {
        model,
        ...(sideQuestion ? { mode: "plan" } : {}),
        local: customTools ? { customTools } : {},
        onDelta: ({ update }) => {
          mark("firstUpdate");
          if (update.type === "step-started" || update.type === "step-completed") steps.add(update.stepId);
          if (update.type === "step-completed") stepDurations.set(update.stepId, update.stepDurationMs);
          if (update.type === "token-delta") mark("firstToken");
        },
      };

      let streamed = "";
      let usage;
      let lastPing = 0;
      let result;
      for (let attempt = 0; ; attempt += 1) {
        if (turnAbort.signal.aborted) throw abortError(turnAbort.signal);
        let progressed = false; // text or a tool call reached OpenClaw / ran
        let failure;
        let run;
        const onUnsettled = reportUnsettled(cache, agentId, cwd, opts.log);
        try {
          run = await measure("send", () => sendRun(agent, message, sendOptions, turnAbort.signal, onUnsettled));
        } catch (err) {
          failure = err;
        }
        const sentAt = elapsed();
        if (run?.requestId) runIds.push(run.requestId);
        if (run) {
          let finished = false;
          const control = controlRun(run, turnAbort.signal, onUnsettled);
          const streamStarted = performance.now();
          let streamEnded = false;
          const finishStreamTiming = () => {
            if (streamEnded) return;
            streamEnded = true;
            timing.streamMs = (timing.streamMs ?? 0) + performance.now() - streamStarted;
          };
          phase = "stream";
          try {
            for await (const m of control.stream()) {
              mark("firstEvent");
              if (m.type === "assistant" || m.type === "tool_call" || m.type === "thinking") {
                mark("first");
                timing.activityWaitMs ??= elapsed() - sentAt;
              }
              if (m.type === "tool_call" && (m.status === "completed" || m.status === "error")) timing.lastTool = elapsed();
              if (m.type === "assistant") {
                for (const block of m.message?.content ?? []) {
                  if (block?.type !== "text" || !block.text) continue;
                  mark("firstText");
                  timing.textWaitMs ??= elapsed() - sentAt;
                  progressed = true;
                  streamed += block.text;
                  yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } }, session_id: agentId };
                }
              } else if (m.type === "usage") {
                usageEvents += 1;
                usage = toClaudeUsage(m.usage);
              } else if (m.type === "thinking" && m.text) {
                mark("firstThinking");
                yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: m.text } }, session_id: agentId };
              } else if (m.type === "tool_call") {
                if (!m.call_id || !m.name) throw new Error("Cursor emitted a tool call without its id or name");
                progressed = true;
                mark("firstTool");
                if (observeNativeTool(m.name)) opts.log?.(`cursor-cli: Cursor used native tool "${m.name}" that tool-policy.js does not classify; capped runs are refused until it is added`);
                if (!toolCalls.has(m.call_id)) {
                  toolCalls.add(m.call_id);
                  const bridged = m.name === "mcp" && m.args?.providerIdentifier === "custom-user-tools"
                    && typeof m.args.toolName === "string" && Object.hasOwn(customTools ?? {}, m.args.toolName);
                  const name = bridged ? `mcp__openclaw__${m.args.toolName}` : m.name;
                  const input = bridged ? m.args.args ?? {} : m.args ?? {};
                  yield { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: m.call_id, name, input }] }, session_id: agentId };
                }
                if ((m.status === "completed" || m.status === "error") && !toolResults.has(m.call_id)) {
                  toolResults.add(m.call_id);
                  const content = typeof m.result === "string" ? m.result : JSON.stringify(m.result ?? "");
                  const isError = m.status === "error" || m.result?.status === "error" || m.result?.value?.isError === true;
                  yield { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: m.call_id, content, is_error: isError }] }, session_id: agentId };
                }
              } else if (m.type === "thinking" || m.type === "task") {
                // SDK task records are summaries, not Claude background-task lifecycles.
                if (Date.now() - lastPing > 5000) {
                  lastPing = Date.now();
                  yield { type: "stream_event", event: { type: "ping" }, session_id: agentId };
                }
              }
              if (finalDelivered && opts.finishOnFinalMessage !== false) {
                // Skip the wrap-up model call (~1.5-2 s): the answer has been delivered.
                finishStreamTiming();
                const stopped = await measure("stop", () => control.stop());
                result = { ...stopped, status: "finished", result: SILENT_TOKEN };
                finished = true;
                opts.log?.(`cursor-cli: final message delivered; ended Cursor run early agent=${agentId}`);
                break;
              }
            }
            finishStreamTiming();
            if (!finished) {
              result = await measure("wait", () => control.wait());
              finished = true;
            }
          } catch (err) {
            failure = err;
            failurePhase ??= phase;
          } finally {
            finishStreamTiming();
            await measure("cleanup", () => control.close());
          }
        }
        if (turnAbort.signal.aborted) throw abortError(turnAbort.signal);
        const message_ = failure ? failure.message : result?.status === "error" ? result.error?.message : undefined;
        // A cached Cursor access token can expire server-side (seen after 1.5-5 h idle). The
        // SDK only re-exchanges it on a transport-level Unauthenticated error, not when the
        // run itself reports "Authentication error". Release our executor reference before
        // reopening; another cached agent may still hold that executor. Retry only once,
        // and never after text or tool execution.
        if (attempt === 0 && !progressed && (failure || result?.status === "error") && isRetryableAuthError(message_)) {
          opts.log?.(`cursor-cli: ${message_}; reopening Cursor agent ${agentId} and retrying once`);
          pluginRetries += 1;
          failurePhase = undefined;
          if (!sideQuestion) { if (acquired) cache.release(agentId, cwd); acquired = false; await cache.deleteAndDispose(agentId, cwd); }
          else await disposeAgent(agent);
          if (turnAbort.signal.aborted) throw abortError(turnAbort.signal);
          agent = await measure("retryOpen", () => sdk.Agent.resume(agentId, { apiKey, model, local }));
          if (!sideQuestion) { cache.set(agent, cwd); cache.acquire(agentId, cwd); acquired = true; }
          continue;
        }
        if (failure) throw failure;
        break;
      }
      phase = "result";
      if (result.status === "cancelled") throw new Error("Cursor run was cancelled");
      if (result.status === "error") throw new Error(`Cursor run failed: ${result.error?.message ?? "unknown error"}`);
      usage = toClaudeUsage(result.usage) ?? usage;
      const perCall = estimatePerCallUsage(usage, toolCalls.size + 1);
      // Context-size sample for OpenClaw (the terminal result's usage then counts as the run total).
      if (perCall) yield { type: "stream_event", event: { type: "message_delta" }, usage: perCall, session_id: agentId };
      const finalText = normalizeFinalText(typeof result.result === "string" && result.result ? result.result : streamed, { messagedThisTurn });
      if (seed) state.clearSeed(agentId);
      ctxTokens = contextTokens(perCall);
      const threshold = autoCompactThreshold(model, { tokens: autoCompactTokens, percent: autoCompactPercent });
      if (!sideQuestion && threshold && ctxTokens > threshold) {
        compactAfter = { sdk, agentId, model, apiKey, ctxTokens, threshold };
      }
      completed = true;
      outcome = "success";
      mark("result");
      yield { type: "result", subtype: "success", is_error: false, result: finalText, session_id: agentId, ...(usage ? { usage } : {}) };
    } catch (err) {
      outcome = turnAbort.signal.aborted ? "cancelled" : "error";
      failurePhase ??= phase;
      throw err;
    } finally {
      if (outcome === "interrupted" && turnAbort.signal.aborted) outcome = "cancelled";
      const attempts = runIds.reduce((n, id) => n + (streamAttempts.get(id) ?? 0), 0);
      const cleanupStarted = performance.now();
      try {
        for (const id of runIds) streamAttempts.delete(id);
        ctx.abortSignal?.removeEventListener("abort", onAbort);
        const scheduleCompact = completed && compactAfter && !turnAbort.signal.aborted;
        if (!turnAbort.signal.aborted) turnAbort.abort(new Error("turn finished"));
        if (acquired) cache.release(agentId, cwd);
        if (sideQuestion) await disposeAgent(agent);
        if (scheduleCompact) {
          const c = compactAfter;
          opts.log?.(`cursor-cli: context agent=${c.agentId} ~${c.ctxTokens} tokens > ${c.threshold}; compacting in the background`);
          // Reserve its place before releasing this turn, including the startup delay.
          compactAgent({ sdk: c.sdk, cache, state, agentId: c.agentId, cwd, model: c.model, apiKey: c.apiKey, log: opts.log, delayMs: opts.compactDelayMs ?? 2000 })
            .catch((err) => opts.log?.(`cursor-cli: compaction of agent=${c.agentId} failed: ${err.message}`));
        }
      } finally {
        releaseSession?.();
        timing.cleanupMs = (timing.cleanupMs ?? 0) + performance.now() - cleanupStarted;
        const durations = Object.fromEntries(Object.entries(timing).filter(([key]) => key.endsWith("Ms")).map(([key, value]) => [key, Math.round(value)]));
        const total = elapsed();
        const metrics = {
          version: 1, outcome, operation, agentMode,
          requestedSessionId: ctx.useResume ? ctx.sessionId : undefined,
          ...(outcome !== "success" ? { phase: failurePhase ?? phase } : {}),
          ...durations,
          firstEventMs: timing.firstEvent, firstActivityMs: timing.first, firstTextMs: timing.firstText,
          firstThinkingMs: timing.firstThinking, firstUpdateMs: timing.firstUpdate, firstTokenMs: timing.firstToken,
          firstToolMs: timing.firstTool, lastToolMs: timing.lastTool, deliveredMs: timing.delivered,
          resultMs: timing.result, totalMs: total,
          ...(timing.abort !== undefined ? { abortMs: timing.abort, abortToReturnMs: total - timing.abort } : {}),
          ...(agentId && cache.entries.get(cache.key(agentId, cwd))?.unsettled ? { quarantined: true } : {}),
          streamAttempts: attempts || undefined, pluginRetries, mcpCalls, steps: steps.size, usageEvents,
          sdkStepMs: Math.round([...stepDurations.values()].reduce((sum, ms) => sum + ms, 0)),
          ...(ctxTokens !== undefined ? { contextEstimate: { tokens: ctxTokens, divisor: toolCalls.size + 1, method: "tool-count-heuristic" } } : {}),
        };
        // Keep the legacy fields; metrics separates durations from elapsed milestones.
        // Logging here also captures failed/aborted turns and actual iterator cleanup.
        opts.log?.(`cursor-cli: timing agent=${agentId ?? "-"} sdk=${timing.sdk ?? "-"} tools=${timing.tools ?? "-"}(${toolCount}${timing.toolsCached ? ",cached" : ""}) agent=${timing.agent ?? "-"} send=${durations.sendMs ?? "-"} first=${timing.first ?? "-"} attempts=${attempts || "-"} lastTool=${timing.lastTool ?? "-"} total=${total} calls=${toolCalls.size}${finalDelivered && opts.finishOnFinalMessage !== false ? " early-finish" : ""} ctx=${ctxTokens ?? "-"} inst=${MODULE_INSTANCE}/t${threadId} metrics=${JSON.stringify(metrics)}`);
      }
    }
  };
}
