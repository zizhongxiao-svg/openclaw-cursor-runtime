// Persistent cursor-agent ACP transport for the OpenClaw cursor-cli backend.
//
// One long-lived `cursor-agent acp` process (per API key) serves every OpenClaw
// session. Sessions are created with session/new, reopened with session/load when
// the process restarted, and driven with session/prompt. Output is translated into
// the claude-stream-json records OpenClaw's parser already understands.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

const IDLE_MS = 20 * 60 * 1000;
const RPC_TIMEOUT_MS = 120 * 1000;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

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

function readApiKey(env, apiKeyFile) {
  if (env.CURSOR_API_KEY) return env.CURSOR_API_KEY;
  if (!apiKeyFile) return undefined;
  const file = apiKeyFile.replace(/^~(?=\/)/u, os.homedir());
  return readFileSync(file, "utf8").trim();
}

class AcpProcess {
  constructor({ command, env, log }) {
    this.log = log;
    this.nextId = 0;
    this.pending = new Map();
    this.sessions = new Map(); // sessionId -> { listener, model, cwd }
    this.loaded = new Set();
    this.busy = 0;
    this.lastUsed = Date.now();
    this.exited = false;
    this.child = spawn(command, ["acp"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.exitPromise = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      const err = new Error(`cursor-agent acp exited (code=${code} signal=${signal})`);
      if (process.env.CURSOR_CLI_DEBUG) console.error("exit pending:", [...this.pending.values()].map((p) => p.method));
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      for (const s of this.sessions.values()) s.listener?.({ exit: err });
      clearInterval(this.idleTimer);
    });
    this.child.once("error", (err) => { this.exited = true; this.log?.(`cursor-cli: spawn failed: ${err.message}`); });
    this.child.stdin.on("error", () => {});
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
    this.idleTimer = setInterval(() => {
      if (this.busy === 0 && Date.now() - this.lastUsed > IDLE_MS) this.close("idle");
    }, 60 * 1000);
    this.idleTimer.unref?.();
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
    this.lastUsed = Date.now();
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

  close(reason) {
    if (this.exited) return;
    this.log?.(`cursor-cli: closing cursor-agent acp (${reason})`);
    try { this.child.kill("SIGTERM"); } catch {}
    setTimeout(() => { if (!this.exited) try { this.child.kill("SIGKILL"); } catch {} }, 5000).unref?.();
  }
}

const pool = new Map(); // apiKey|command -> AcpProcess
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

function pickPermissionOption(options, allow) {
  const list = Array.isArray(options) ? options : [];
  const kinds = allow ? ["allow_always", "allow_once"] : ["reject_once", "reject_always"];
  for (const k of kinds) { const o = list.find((x) => x?.kind === k); if (o) return o.optionId; }
  return list[0]?.optionId;
}

function buildPromptText({ systemPrompt, prompt, promptContext, isNew }) {
  const parts = [];
  if (isNew && systemPrompt) parts.push(`<system_instructions>\n${systemPrompt}\n</system_instructions>`);
  if (promptContext?.prependContext) parts.push(promptContext.prependContext);
  parts.push(prompt ?? "");
  if (promptContext?.appendContext) parts.push(promptContext.appendContext);
  return parts.join("\n\n");
}

/**
 * Build the plugin-owned execute transport. Yields claude-stream-json records.
 * @param {{ command?: string, apiKeyFile?: string, force?: boolean, modelAliases?: Record<string,string>, log?: (m: string) => void }} opts
 */
/** Test hook: terminate pooled processes. */
export function _closeAllForTest(hard) { for (const p of pool.values()) hard ? process.kill(p.child.pid, "SIGTERM") : p.close("test"); }

export function createAcpExecute(opts = {}) {
  return async function* execute(ctx) {
    const env = { ...process.env, ...ctx.env };
    const apiKey = readApiKey(env, opts.apiKeyFile);
    if (apiKey) env.CURSOR_API_KEY = apiKey;
    const proc = getProcess({ command: opts.command || "cursor-agent", env, log: opts.log });
    proc.busy += 1;
    let sessionId;
    const queue = [];
    let wake;
    const push = (ev) => { queue.push(ev); wake?.(); };
    let onAbort;
    try {
      await proc.ready();
      ctx.assertCurrent?.();
      const cwd = ctx.cwd || process.cwd();
      let isNew = true;
      let models;
      if (ctx.useResume && ctx.sessionId) {
        if (proc.loaded.has(ctx.sessionId)) { sessionId = ctx.sessionId; isNew = false; }
        else {
          try {
            proc.sessions.set(ctx.sessionId, { listener: () => {} }); // swallow history replay
            const r = await proc.call("session/load", { sessionId: ctx.sessionId, cwd, mcpServers: [] });
            models = r?.models;
            sessionId = ctx.sessionId;
            isNew = false;
          } catch (err) {
            proc.sessions.delete(ctx.sessionId);
            opts.log?.(`cursor-cli: session/load ${ctx.sessionId} failed (${err.message}); starting a new session`);
          }
        }
      }
      if (!sessionId) {
        const r = await proc.call("session/new", { cwd, mcpServers: [] });
        sessionId = r.sessionId;
        models = r?.models;
      }
      proc.loaded.add(sessionId);
      const entry = proc.sessions.get(sessionId) ?? {};
      proc.sessions.set(sessionId, entry);

      const wanted = resolveAcpModelId(ctx.modelId, models?.availableModels ?? entry.available, opts.modelAliases);
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

      onAbort = () => proc.notify("session/cancel", { sessionId });
      ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
      const promptText = buildPromptText({ systemPrompt: ctx.systemPrompt, prompt: ctx.prompt, promptContext: ctx.promptContext, isNew });
      const done = proc.call("session/prompt", { sessionId, prompt: [{ type: "text", text: promptText }] }, 0)
        .then((r) => push({ done: r }), (err) => push({ error: err }));
      void done;

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
      if (onAbort) ctx.abortSignal?.removeEventListener("abort", onAbort);
      const entry = sessionId && proc.sessions.get(sessionId);
      if (entry) entry.listener = undefined;
      proc.busy -= 1;
      proc.lastUsed = Date.now();
    }
  };
}
