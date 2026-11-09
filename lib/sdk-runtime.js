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
import { readFileSync } from "node:fs";
import { extractMcpConfigPaths } from "./mcp-relay.js";
import { CURSOR_NATIVE_TOOL_NAMES, observeNativeTool } from "./tool-policy.js";
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

let sdkPromise;
function loadSdk(opts) {
  if (opts.sdk) return Promise.resolve(opts.sdk);
  if (!sdkPromise) {
    sdkPromise = import("@cursor/sdk")
      .then((sdk) => {
        // Process-wide: the first loaded config decides (changing it needs a gateway restart).
        if (opts.useHttp1 !== false) sdk.Cursor.configure({ local: { useHttp1ForAgent: true } });
        return sdk;
      })
      .catch((err) => {
        sdkPromise = undefined; // allow a later turn to retry the import
        throw err;
      });
  }
  return sdkPromise;
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
  for (const file of extractMcpConfigPaths(args)) {
    try {
      const server = JSON.parse(readFileSync(file, "utf8"))?.mcpServers?.openclaw;
      if (server && typeof server.url === "string") return { url: server.url, headers: server.headers ?? {} };
    } catch (err) {
      log?.(`cursor-cli: cannot read MCP config ${file}: ${err.message}`);
    }
  }
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
      if (msg.error) throw new Error(`OpenClaw MCP ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
      return msg.result;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", onAbort);
    }
  }

  async listTools() {
    try {
      await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openclaw-cursor-runtime", version: PACKAGE_VERSION } });
    } catch {}
    const tools = [];
    let cursor;
    do {
      const r = await this.rpc("tools/list", cursor ? { cursor } : {});
      tools.push(...(r?.tools ?? []));
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
  }
}

const sharedToolCache = new ToolListCache();

/** Build SDK customTools that forward to the turn's OpenClaw loopback MCP server. */
async function buildCustomTools(client, log, onCall, allow, { cache, cacheKey, onList } = {}) {
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
    return undefined;
  }
  const customTools = {};
  for (const tool of tools) {
    if (!tool?.name) continue;
    if (allow && !allow.has(tool.name)) continue;
    customTools[tool.name] = {
      description: tool.description ?? `OpenClaw tool ${tool.name}`,
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      execute: async (args) => {
        try {
          const out = toSdkToolResult(await client.rpc("tools/call", { name: tool.name, arguments: args ?? {} }, TOOL_CALL_TIMEOUT_MS));
          if (!out.isError) onCall?.(tool.name, args ?? {});
          return out;
        } catch (err) {
          return { content: [{ type: "text", text: `OpenClaw tool ${tool.name} failed: ${err.message}` }], isError: true };
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
    this.timer = undefined;
  }

  key(agentId, cwd) {
    return `${agentId}\u0000${cwd}`;
  }

  get(agentId, cwd) {
    const e = this.entries.get(this.key(agentId, cwd));
    if (e) e.lastUsed = this.now();
    return e?.agent;
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

  /** Close agents idle longer than idleMs (they are reopened with Agent.resume on demand). */
  sweep() {
    const cutoff = this.now() - this.idleMs;
    for (const [k, e] of this.entries) {
      if (e.busy === 0 && e.lastUsed < cutoff) {
        this.entries.delete(k);
        try { e.agent.close(); } catch {}
      }
    }
    if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
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

const sharedCache = new AgentCache();
process.once("exit", () => sharedCache.closeAll());

function abortError(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error("Cursor turn was aborted");
}

/**
 * Build the plugin-owned execute transport. Yields claude-stream-json records.
 * @param {{ apiKeyFile?: string, useHttp1?: boolean, modelDefaults?: { context?: string },
 *           agentIdleMs?: number, sdk?: object, cache?: AgentCache, log?: (m: string) => void }} opts
 *   `sdk` and `cache` are injection points for tests.
 */
export function createSdkExecute(opts = {}) {
  const cache = opts.cache ?? (opts.agentIdleMs !== undefined ? new AgentCache({ idleMs: opts.agentIdleMs }) : sharedCache);

  return async function* execute(ctx) {
    const turnAbort = new AbortController();
    const onAbort = () => turnAbort.abort(ctx.abortSignal?.reason);
    if (ctx.abortSignal?.aborted) onAbort();
    else ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });

    const cwd = ctx.cwd || process.cwd();
    const sideQuestion = ctx.executionMode === "side-question";
    let agent;
    let agentId;
    let acquired = false;
    // Per-turn timing (ms since execute started), logged once at the end of the turn.
    const t0 = Date.now();
    const timing = {};
    const mark = (k) => { timing[k] ??= Date.now() - t0; };
    try {
      const sdk = await loadSdk(opts);
      mark("sdk");
      const apiKey = readApiKey({ ...process.env, ...ctx.env }, opts.apiKeyFile, opts.log);
      const model = resolveModelSelection(ctx.modelId, ctx.thinkingLevel, {
        ...opts.modelDefaults,
        ...(ctx.contextWindowOption ? { context: ctx.contextWindowOption } : {}),
      });
      const local = { cwd, settingSources: [] };
      const loopback = readLoopback(ctx.args, opts.log);
      let messagedThisTurn = false;
      // Set when the agent delivered its terminal answer with message(final:true). After
      // that the only expected step is a bare NO_REPLY, so the turn can end right away.
      let finalDelivered = false;
      const onToolCall = (name, args) => {
        if (MESSAGING_TOOLS.has(name)) messagedThisTurn = true;
        if (isFinalMessageCall(name, args)) finalDelivered = true;
      };
      const customTools = loopback && !sideQuestion
        ? await buildCustomTools(new LoopbackClient(loopback, turnAbort.signal), opts.log, onToolCall, ctx.openClawAllow, {
            cache: opts.toolListCache === false ? undefined : (opts.toolListCache ?? sharedToolCache),
            cacheKey: ToolListCache.key(cwd, ctx.openClawAllow),
            onList: (cached) => { timing.toolsCached = cached; },
          })
        : undefined;
      mark("tools");
      if (turnAbort.signal.aborted) throw abortError(turnAbort.signal);

      let isNew = true;
      ctx.assertCurrent?.();
      if (!sideQuestion && ctx.useResume && ctx.sessionId) {
        agent = cache.get(ctx.sessionId, cwd);
        if (agent) isNew = false;
        else {
          try {
            agent = await sdk.Agent.resume(ctx.sessionId, { apiKey, model, local });
            cache.set(agent, cwd);
            isNew = false;
          } catch (err) {
            opts.log?.(`cursor-cli: resume ${ctx.sessionId} failed (${err.message}); starting a new Cursor agent`);
          }
        }
      }
      if (!agent) {
        agent = await sdk.Agent.create({ apiKey, model, local, name: sideQuestion ? "openclaw side question" : "openclaw", ...(sideQuestion ? { mode: "plan" } : {}) });
        if (!sideQuestion) cache.set(agent, cwd);
      }
      agentId = agent.agentId;
      if (!sideQuestion) { cache.acquire(agentId, cwd); acquired = true; }
      mark("agent");
      // Makes /think observable: the effort actually sent to Cursor for this turn.
      opts.log?.(`cursor-cli: ${sideQuestion ? "side question" : "turn"} agent=${agentId} ${describeModelSelection(model)} think=${ctx.thinkingLevel ?? "default"}${isNew ? " new-agent" : ""}`);

      // claude-stream-json init: `tools` feeds OpenClaw's native tool authority projection.
      yield { type: "system", subtype: "init", session_id: agentId, model: model.id, cwd, tools: sideQuestion ? [] : [...CURSOR_NATIVE_TOOL_NAMES] };

      const text = buildPromptText({ systemPrompt: ctx.systemPrompt, prompt: ctx.prompt, promptContext: ctx.promptContext, isNew });
      const images = readImages(extractImagePaths(ctx.args), opts.log);
      const message = images.length ? { text, images } : text;
      const sendOptions = {
        model,
        ...(sideQuestion ? { mode: "plan" } : {}),
        local: customTools ? { customTools } : {},
      };

      let streamed = "";
      let usage;
      let lastPing = 0;
      const toolCalls = new Set();
      let result;
      for (let attempt = 0; ; attempt += 1) {
        if (turnAbort.signal.aborted) throw abortError(turnAbort.signal);
        let progressed = false; // text or a tool call reached OpenClaw / ran
        let failure;
        let run;
        try {
          run = await agent.send(message, sendOptions);
        } catch (err) {
          failure = err;
        }
        if (run) {
          let finished = false;
          const cancel = () => { run.cancel?.().catch?.(() => {}); };
          turnAbort.signal.addEventListener("abort", cancel, { once: true });
          if (turnAbort.signal.aborted) cancel();
          try {
            for await (const m of run.stream()) {
              if (m.type === "assistant" || m.type === "tool_call" || m.type === "thinking") mark("first");
              if (m.type === "tool_call" && m.status === "completed") timing.lastTool = Date.now() - t0;
              if (m.type === "assistant") {
                for (const block of m.message?.content ?? []) {
                  if (block?.type !== "text" || !block.text) continue;
                  progressed = true;
                  streamed += block.text;
                  yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } }, session_id: agentId };
                }
              } else if (m.type === "usage") {
                usage = toClaudeUsage(m.usage);
              } else if (m.type === "tool_call" || m.type === "thinking" || m.type === "task") {
                if (m.type === "tool_call") {
                  progressed = true;
                  if (m.call_id) toolCalls.add(m.call_id);
                  if (observeNativeTool(m.name)) opts.log?.(`cursor-cli: Cursor used native tool "${m.name}" that tool-policy.js does not classify; capped runs are refused until it is added`);
                }
                if (Date.now() - lastPing > 5000) {
                  lastPing = Date.now();
                  yield { type: "stream_event", event: { type: "ping" }, session_id: agentId };
                }
              }
              if (finalDelivered && opts.finishOnFinalMessage !== false) {
                // Skip the wrap-up model call (~1.5-2 s): the answer has been delivered.
                cancel();
                result = { status: "finished", result: SILENT_TOKEN };
                finished = true;
                opts.log?.(`cursor-cli: final message delivered; ended Cursor run early agent=${agentId}`);
                break;
              }
            }
            if (!finished) {
              result = await run.wait();
              finished = true;
            }
          } catch (err) {
            failure = err;
          } finally {
            turnAbort.signal.removeEventListener("abort", cancel);
            // Consumer stopped early, the stream threw, or the turn was aborted: stop the
            // Cursor run so its tools do not keep running without a turn.
            if (!finished) cancel();
          }
        }
        if (turnAbort.signal.aborted) throw abortError(turnAbort.signal);
        const message_ = failure ? failure.message : result?.status === "error" ? result.error?.message : undefined;
        // A cached Cursor access token can expire server-side (seen after ~1.5 h idle); the
        // SDK re-exchanges on the next request. Retry once when nothing has run yet.
        if (attempt === 0 && !progressed && (failure || result?.status === "error") && isRetryableAuthError(message_)) {
          opts.log?.(`cursor-cli: ${message_}; reconnecting Cursor agent ${agentId} and retrying once`);
          if (!sideQuestion) { if (acquired) cache.release(agentId, cwd); acquired = false; cache.delete(agentId, cwd); }
          else try { agent.close(); } catch {}
          agent = await sdk.Agent.resume(agentId, { apiKey, model, local });
          if (!sideQuestion) { cache.set(agent, cwd); cache.acquire(agentId, cwd); acquired = true; }
          continue;
        }
        if (failure) throw failure;
        break;
      }
      if (result.status === "cancelled") throw new Error("Cursor run was cancelled");
      if (result.status === "error") throw new Error(`Cursor run failed: ${result.error?.message ?? "unknown error"}`);
      usage = toClaudeUsage(result.usage) ?? usage;
      const perCall = estimatePerCallUsage(usage, toolCalls.size + 1);
      // Context-size sample for OpenClaw (the terminal result's usage then counts as the run total).
      if (perCall) yield { type: "stream_event", event: { type: "message_delta" }, usage: perCall, session_id: agentId };
      const finalText = normalizeFinalText(typeof result.result === "string" && result.result ? result.result : streamed, { messagedThisTurn });
      // Where the turn's time went: sdk load, OpenClaw tool list, agent open, first Cursor
      // event (model latency), last tool completion, total.
      opts.log?.(`cursor-cli: timing agent=${agentId} sdk=${timing.sdk ?? "-"} tools=${timing.tools ?? "-"}(${customTools ? Object.keys(customTools).length : 0}${timing.toolsCached ? ",cached" : ""}) agent=${timing.agent ?? "-"} first=${timing.first ?? "-"} lastTool=${timing.lastTool ?? "-"} total=${Date.now() - t0} calls=${toolCalls.size}${finalDelivered && opts.finishOnFinalMessage !== false ? " early-finish" : ""}`);
      yield { type: "result", subtype: "success", is_error: false, result: finalText, session_id: agentId, ...(usage ? { usage } : {}) };
    } finally {
      ctx.abortSignal?.removeEventListener("abort", onAbort);
      if (!turnAbort.signal.aborted) turnAbort.abort(new Error("turn finished"));
      if (acquired) cache.release(agentId, cwd);
      if (sideQuestion) try { agent?.close(); } catch {}
    }
  };
}
