// Persistent cursor-agent ACP transport for the OpenClaw cursor-cli backend.
//
// One long-lived `cursor-agent acp` process (per API key) serves every OpenClaw
// session. Like OpenClaw's Claude live sessions it has no idle timeout: it lives until
// the gateway stops or it crashes (the next turn then respawns it). Sessions are
// created with session/new, reopened with session/load after a process restart, and
// driven with session/prompt. Output is translated into the claude-stream-json
// records OpenClaw's parser already understands.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { McpRelay, extractMcpConfigPaths, toAcpMcpServer } from "./mcp-relay.js";
import {
  EFFORTS,
  THINKING_TO_EFFORT,
  buildPromptText,
  childEnv,
  extractImagePaths,
  readApiKey,
  readImages,
} from "./common.js";

const RPC_TIMEOUT_MS = 120 * 1000;
/** How long a cancelled prompt may take to stop before the process is restarted. */
const CANCEL_GRACE_MS = 30 * 1000;

/** Apply an OpenClaw thinking level to a Cursor ACP model id's effort parameter. */
export function applyThinking(modelId, thinkingLevel) {
  const effort = THINKING_TO_EFFORT[thinkingLevel];
  if (!modelId || !effort || !modelId.includes("[")) return modelId;
  return modelId.replace(/\b(effort|reasoning_effort|reasoning)=[a-z]+/u, `$1=${effort}`);
}

/** Map an OpenClaw model id (e.g. claude-opus-5-5-medium) to a Cursor ACP model id. */
export function resolveAcpModelId(modelId, available, aliases = {}) {
  const id = String(modelId ?? "").trim();
  if (!id || id === "default") return undefined;
  if (aliases[id]) return aliases[id];
  if (id.includes("[")) return id;
  const list = Array.isArray(available) ? available.map((m) => m?.modelId).filter(Boolean) : [];
  if (list.includes(id)) return id;
  const parts = id.split("-");
  const effort = EFFORTS.has(parts.at(-1)) ? parts.pop() : undefined;
  const base = parts.join("-");
  const match = list.find((m) => m.split("[")[0] === base);
  if (!match) return id; // let Cursor reject it so the turn fails over
  if (!effort) return match;
  return match.replace(/\b(effort|reasoning_effort|reasoning)=[a-z]+/u, `$1=${effort}`);
}

/** Split the turn's --mcp-config servers into the OpenClaw loopback server and static ones. */
function readMcpServers(args, log) {
  let openclaw;
  const others = [];
  for (const file of extractMcpConfigPaths(args)) {
    let cfg;
    try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch (err) { log?.(`cursor-cli: cannot read MCP config ${file}: ${err.message}`); continue; }
    for (const [name, server] of Object.entries(cfg?.mcpServers ?? {})) {
      if (name === "openclaw" && typeof server?.url === "string") openclaw = { url: server.url, headers: server.headers ?? {} };
      else { const acp = toAcpMcpServer(name, server); if (acp) others.push(acp); }
    }
  }
  return { openclaw, others };
}

const relay = new McpRelay();

class AcpProcess {
  constructor({ command, env, log }) {
    this.log = log;
    this.nextId = 0;
    this.pending = new Map();
    this.sessions = new Map(); // sessionId -> { listener, model, available, routeId }
    this.loaded = new Set();
    this.exited = false;
    this.child = spawn(command, ["acp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      const err = new Error(`cursor-agent acp exited (code=${code} signal=${signal})`);
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err); }
      this.pending.clear();
      for (const s of this.sessions.values()) {
        s.listener?.({ exit: err });
        if (s.routeId) relay.deleteRoute(s.routeId);
      }
    });
    this.child.once("error", (err) => { this.exited = true; this.log?.(`cursor-cli: spawn failed: ${err.message}`); });
    this.child.stdin.on("error", () => {});
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    let stderr = "";
    this.child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); this.stderrTail = stderr; });
    let buf = "";
    this.child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.onLine(line);
      }
    });
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && (msg.result !== undefined || msg.error) && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(Object.assign(new Error(msg.error.data?.message || msg.error.message || "ACP error"), { acp: msg.error }));
      else resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      this.sessions.get(msg.params?.sessionId)?.listener?.({ update: msg.params.update });
      return;
    }
    if (msg.method && msg.id != null) {
      const session = this.sessions.get(msg.params?.sessionId);
      if (session?.listener) session.listener({ request: msg });
      else this.respond(msg.id, undefined, { code: -32601, message: "no active turn" });
    }
  }

  respond(id, result, error) {
    if (this.exited) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`);
  }

  call(method, params, timeoutMs = RPC_TIMEOUT_MS) {
    if (this.exited) return Promise.reject(new Error("cursor-agent acp is not running"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cursor-agent acp ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params) {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async ready() {
    if (!this.initPromise) {
      this.initPromise = this.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    }
    return this.initPromise;
  }

  forgetSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (s?.routeId) relay.deleteRoute(s.routeId);
    this.sessions.delete(sessionId);
    this.loaded.delete(sessionId);
  }

  close(reason) {
    if (this.exited) return;
    this.log?.(`cursor-cli: closing cursor-agent acp (${reason})`);
    try { this.child.kill("SIGTERM"); } catch {}
    setTimeout(() => { if (!this.exited) try { this.child.kill("SIGKILL"); } catch {} }, 5000).unref?.();
  }
}

const pool = new Map(); // command|apiKey -> AcpProcess
let exitHookInstalled = false;

function getProcess({ command, env, log }) {
  const key = `${command}\u0000${env.CURSOR_API_KEY ?? ""}`;
  let proc = pool.get(key);
  if (!proc || proc.exited) {
    proc = new AcpProcess({ command, env, log });
    pool.set(key, proc);
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once("exit", () => { for (const p of pool.values()) try { p.child.kill("SIGTERM"); } catch {} });
    }
  }
  return proc;
}

/** Prefer one-shot grants: a turn's approval must not outlive the turn. */
export function pickPermissionOption(options, allow) {
  const list = Array.isArray(options) ? options : [];
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const k of kinds) { const o = list.find((x) => x?.kind === k); if (o) return o.optionId; }
  return allow ? list[0]?.optionId : list.find((x) => /reject|deny/i.test(String(x?.kind ?? x?.optionId)))?.optionId ?? list.at(-1)?.optionId;
}

/** Test hook (test/live): terminate pooled processes. */
export function closeAllForTest(hard) { for (const p of pool.values()) hard ? process.kill(p.child.pid, "SIGTERM") : p.close("test"); }

/**
 * Build the plugin-owned execute transport. Yields claude-stream-json records.
 * @param {{ command?: string, apiKeyFile?: string, force?: boolean, modelAliases?: Record<string,string>, log?: (m: string) => void }} opts
 */
export function createAcpExecute(opts = {}) {
  return async function* execute(ctx) {
    if (ctx.abortSignal?.aborted) throw new Error("cursor-agent turn was aborted");
    const env = childEnv(process.env, ctx.env);
    const apiKey = readApiKey({ ...process.env, ...ctx.env }, opts.apiKeyFile, opts.log);
    if (apiKey) env.CURSOR_API_KEY = apiKey;
    const proc = getProcess({ command: opts.command || "cursor-agent", env, log: opts.log });
    const sideQuestion = ctx.executionMode === "side-question";
    let sessionId;
    let routeId;
    const queue = [];
    let wake;
    const push = (ev) => { queue.push(ev); wake?.(); };
    let onAbort;
    let cancelTimer;
    try {
      await proc.ready();
      ctx.assertCurrent?.();
      const cwd = ctx.cwd || process.cwd();
      let isNew = true;
      let models;
      const mcp = readMcpServers(ctx.args, opts.log);
      if (mcp.openclaw) await relay.start();
      const openMcp = () => {
        const id = mcp.openclaw ? relay.newRoute() : undefined;
        const servers = [...mcp.others];
        if (id) servers.push({ type: "http", name: "openclaw", url: relay.urlFor(id), headers: [] });
        return { routeId: id, servers };
      };
      let opened;
      if (!sideQuestion && ctx.useResume && ctx.sessionId) {
        const known = proc.sessions.get(ctx.sessionId);
        if (proc.loaded.has(ctx.sessionId) && (known?.routeId || !mcp.openclaw)) { sessionId = ctx.sessionId; isNew = false; }
        else {
          try {
            opened = openMcp();
            const holder = known ?? {};
            holder.listener = () => {}; // swallow history replay
            proc.sessions.set(ctx.sessionId, holder);
            const r = await proc.call("session/load", { sessionId: ctx.sessionId, cwd, mcpServers: opened.servers });
            holder.listener = undefined;
            models = r?.models;
            sessionId = ctx.sessionId;
            isNew = false;
          } catch (err) {
            if (opened?.routeId) relay.deleteRoute(opened.routeId);
            opened = undefined;
            if (!known) proc.sessions.delete(ctx.sessionId);
            opts.log?.(`cursor-cli: session/load ${ctx.sessionId} failed (${err.message}); starting a new session`);
          }
        }
      }
      if (!sessionId) {
        opened = openMcp();
        const r = await proc.call("session/new", { cwd, mcpServers: opened.servers });
        sessionId = r.sessionId;
        models = r?.models;
        // Side questions must not run in full agent mode; fail the turn if read-only mode is unavailable.
        if (sideQuestion) await proc.call("session/set_mode", { sessionId, modeId: "ask" });
      }
      if (!sideQuestion) proc.loaded.add(sessionId);
      const entry = proc.sessions.get(sessionId) ?? {};
      proc.sessions.set(sessionId, entry);
      if (opened?.routeId) {
        if (entry.routeId && entry.routeId !== opened.routeId) relay.deleteRoute(entry.routeId);
        entry.routeId = opened.routeId;
      }
      routeId = entry.routeId;
      if (routeId) relay.setTarget(routeId, mcp.openclaw);

      const wanted = applyThinking(resolveAcpModelId(ctx.modelId, models?.availableModels ?? entry.available, opts.modelAliases), ctx.thinkingLevel ?? opts.thinkingLevel);
      if (models?.availableModels) entry.available = models.availableModels;
      const current = entry.model ?? models?.currentModelId;
      if (wanted && wanted !== current) {
        await proc.call("session/set_model", { sessionId, modelId: wanted });
        entry.model = wanted;
      } else if (current) entry.model = current;

      yield { type: "system", subtype: "init", session_id: sessionId, model: entry.model, cwd };

      let text = "";
      entry.listener = (ev) => {
        if (ev.exit) { push({ error: ev.exit }); return; }
        if (ev.request) {
          const m = ev.request;
          if (m.method === "session/request_permission") {
            const decide = async () => {
              let allow = opts.force !== false;
              if (!allow) {
                const tc = m.params?.toolCall ?? {};
                try {
                  const res = await ctx.requestToolPermission({ toolName: tc.title || tc.kind || "tool", toolInput: tc.rawInput ?? {}, toolCallId: tc.toolCallId, cwd });
                  allow = res?.behavior === "allow";
                } catch { allow = false; }
              }
              proc.respond(m.id, { outcome: { outcome: "selected", optionId: pickPermissionOption(m.params?.options, allow) } });
            };
            decide();
          } else proc.respond(m.id, undefined, { code: -32601, message: `unsupported client method ${m.method}` });
          return;
        }
        const u = ev.update;
        if (!u) return;
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text" && u.content.text) {
          text += u.content.text;
          push({ record: { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: u.content.text } }, session_id: sessionId } });
        } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update" || u.sessionUpdate === "agent_thought_chunk") {
          push({ record: { type: "stream_event", event: { type: "ping" }, session_id: sessionId } });
        }
      };

      onAbort = () => {
        proc.notify("session/cancel", { sessionId });
        // If cursor-agent ignores the cancel, end the turn and recycle the process.
        cancelTimer = setTimeout(() => {
          push({ error: new Error("cursor-agent did not stop after cancel; restarting it") });
          proc.close("cancel timeout");
        }, CANCEL_GRACE_MS);
        cancelTimer.unref?.();
      };
      if (ctx.abortSignal?.aborted) onAbort();
      else ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
      const promptText = buildPromptText({ systemPrompt: ctx.systemPrompt, prompt: ctx.prompt, promptContext: ctx.promptContext, isNew });
      const images = readImages(extractImagePaths(ctx.args), opts.log).map((i) => ({ type: "image", ...i }));
      proc.call("session/prompt", { sessionId, prompt: [{ type: "text", text: promptText }, ...images] }, 0)
        .then((r) => push({ done: r }), (err) => push({ error: err }));

      let lastPing = 0;
      for (;;) {
        while (queue.length === 0) await new Promise((r) => { wake = r; });
        wake = undefined;
        const ev = queue.shift();
        if (ev.record) {
          if (ev.record.event?.type === "ping") {
            if (Date.now() - lastPing < 5000) continue;
            lastPing = Date.now();
          }
          yield ev.record;
          continue;
        }
        if (ev.error) throw ev.error;
        if (ev.done) {
          const stop = ev.done?.stopReason;
          if (stop === "cancelled") throw new Error("cursor-agent turn was cancelled");
          if (stop === "refusal") {
            yield { type: "result", subtype: "error_during_execution", is_error: true, result: text || "Cursor refused the request.", session_id: sessionId };
            return;
          }
          yield { type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, stop_reason: stop };
          return;
        }
      }
    } catch (err) {
      if (proc.exited && proc.stderrTail) opts.log?.(`cursor-cli: acp stderr: ${proc.stderrTail.slice(-500)}`);
      throw err;
    } finally {
      clearTimeout(cancelTimer);
      if (onAbort) ctx.abortSignal?.removeEventListener("abort", onAbort);
      if (routeId) relay.setTarget(routeId, null);
      if (sessionId) {
        if (sideQuestion) proc.forgetSession(sessionId);
        else { const entry = proc.sessions.get(sessionId); if (entry) entry.listener = undefined; }
      }
    }
  };
}
