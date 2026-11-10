// Offline unit tests: no Cursor account, network or OpenClaw gateway needed.
// Run with `npm test` (node --test).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentCache,
  createSdkExecute,
  describeModelSelection,
  estimatePerCallUsage,
  isRetryableAuthError,
  normalizeFinalText,
  resolveModelSelection,
  toClaudeUsage,
  ToolListCache,
} from "../lib/sdk-runtime.js";

test("ToolListCache: first turn waits for the list, later turns use the cache and refresh in the background", async () => {
  const cache = new ToolListCache();
  const key = ToolListCache.key("/w", new Set(["b", "a"]));
  assert.equal(key, ToolListCache.key("/w", new Set(["a", "b"]))); // order-insensitive
  assert.notEqual(key, ToolListCache.key("/w", undefined));
  let calls = 0;
  let release;
  const slow = () => { calls += 1; return calls === 1 ? Promise.resolve([{ name: "v1" }]) : new Promise((r) => { release = () => r([{ name: "v2" }]); }); };
  const first = await cache.get(key, slow);
  assert.deepEqual(first, { tools: [{ name: "v1" }], cached: false });
  const second = await cache.get(key, slow); // returns at once while the refresh is pending
  assert.deepEqual(second, { tools: [{ name: "v1" }], cached: true });
  assert.equal(calls, 2);
  const third = await cache.get(key, slow); // no second concurrent refresh
  assert.equal(calls, 2);
  assert.equal(third.cached, true);
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual((await cache.get(key, () => Promise.reject(new Error("grant gone")), () => {})).tools, [{ name: "v2" }]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual((await cache.get(key, () => Promise.resolve([]))).tools, [{ name: "v2" }]); // failed refresh kept v2
});
import { applyThinking, pickPermissionOption, resolveAcpModelId } from "../lib/acp-runtime.js";
import { McpRelay, extractMcpConfigPaths, toAcpMcpServer } from "../lib/mcp-relay.js";
import { childEnv, readApiKey } from "../lib/common.js";
import {
  CURSOR_NATIVE_TOOL_NAMES,
  observeNativeTool,
  planToolAvailability,
  projectCursorNativeToolAuthority,
  resetObservedNativeToolsForTest,
} from "../lib/tool-policy.js";
import { buildCursorCliBackend, validateCompactOutput } from "../index.js";
import { SessionState, buildCompactionPrompt, wrapWithSeed } from "../lib/session-state.js";
import { autoCompactThreshold, compactAgent, contextTokens, contextWindowTokens, prewarmSdk } from "../lib/sdk-runtime.js";

// Backends built by tests must never touch the real ~/.cache state file.
process.env.OPENCLAW_CURSOR_STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccli-state-")), "state.json");

// ---------------------------------------------------------------- fake @cursor/sdk

/**
 * Each entry of `script` drives one agent.send():
 *   { throwOnSend?: string, events?: object[], hang?: boolean, result?: object,
 *     sendDelayMs?: number, firstEventDelayMs?: number,
 *     streamUrl?: string, silentAttempts?: number, streamAttempts?: number }
 * silentAttempts / streamAttempts: RunSSE requests the run makes (never connected / completed).
 */
let fakeRunSeq = 0;
function fakeSdk(script) {
  const state = { created: 0, resumed: 0, sends: [], runs: [], agents: [], events: [] };
  class FakeRun {
    constructor(b) { this.b = b; this.cancelled = false; this.requestId = `fake-run-${++fakeRunSeq}`; }
    async *stream() {
      for (let i = 0; i < (this.b.silentAttempts ?? 0); i++) silentRunSse(this.b.streamUrl, this.requestId);
      for (let i = 0; i < (this.b.streamAttempts ?? 0); i++) await postRunSse(this.b.streamUrl, this.requestId);
      if (this.b.firstEventDelayMs) await new Promise((r) => setTimeout(r, this.b.firstEventDelayMs));
      for (const m of this.b.events ?? []) yield m;
      if (this.b.hang) await new Promise((r) => { this.release = r; });
    }
    async wait() { return this.b.result ?? { status: this.cancelled ? "cancelled" : "finished", result: "ok" }; }
    async cancel() { this.cancelled = true; this.release?.(); }
  }
  class FakeAgent {
    constructor(id) { this.agentId = id; this.closed = false; state.agents.push(this); }
    async send(message, options) {
      state.sends.push({ message, options, agentId: this.agentId });
      const b = script.shift() ?? {};
      if (b.sendDelayMs) await new Promise((r) => setTimeout(r, b.sendDelayMs));
      if (b.throwOnSend) throw new Error(b.throwOnSend);
      if (b.callTool) b.toolResult = await options.local.customTools[b.callTool].execute(b.callArgs ?? { text: "hi" }, {});
      const run = new FakeRun(b);
      state.runs.push(run);
      return run;
    }
    close() { this.closed = true; }
    // Like the SDK: resolves once the shared local executor has been released.
    async [Symbol.asyncDispose]() {
      await new Promise((r) => setTimeout(r, 5));
      this.closed = true;
      this.disposed = true;
      state.events.push(`disposed:${this.agentId}`);
    }
  }
  const sdk = {
    Cursor: { configure() {} },
    Agent: {
      create: async () => { state.created += 1; return new FakeAgent(`agent-${state.created}`); },
      resume: async (id) => { state.resumed += 1; state.events.push(`resumed:${id}`); return new FakeAgent(id); },
    },
  };
  return { sdk, state };
}

/** One HTTP request shaped like an SDK stream attempt (RunSSE path, run's request id header). */
function postRunSse(base, requestId) {
  return new Promise((resolve, reject) => {
    http.request(`${base}/agent.v1.AgentService/RunSSE`, { method: "POST", headers: { "x-original-request-id": requestId } }, (res) => res.resume().on("end", resolve))
      .on("error", reject)
      .end();
  });
}

/** A stream attempt whose connection never comes up (a proxy tunnel that never opens), then aborted. */
function silentRunSse(base, requestId) {
  const agent = new (class extends http.Agent { addRequest() {} })();
  const req = http.request(`${base}/agent.v1.AgentService/RunSSE`, { method: "POST", agent, headers: { "x-original-request-id": requestId } });
  req.on("error", () => {});
  req.end();
  req.destroy();
}

function baseCtx(extra = {}) {
  return { cwd: "/tmp", env: { CURSOR_API_KEY: "k" }, args: [], prompt: "hi", modelId: "claude-opus-5-5-medium", systemPrompt: "", useResume: false, timeoutMs: 1000, ...extra };
}

async function collect(gen) {
  const out = [];
  for await (const r of gen) out.push(r);
  return out;
}

// ---------------------------------------------------------------- model selection & text

test("resolveModelSelection maps effort-suffixed ids to SDK params", () => {
  assert.deepEqual(resolveModelSelection("claude-opus-5-5-medium"), {
    id: "claude-opus-5-5",
    params: [{ id: "context", value: "300k" }, { id: "effort", value: "medium" }, { id: "fast", value: "false" }],
  });
  assert.deepEqual(resolveModelSelection("gpt-5.6-sol-high"), { id: "gpt-5.6-sol", params: [{ id: "effort", value: "high" }] });
  assert.deepEqual(resolveModelSelection("composer-2.5"), { id: "composer-2.5" });
  assert.deepEqual(resolveModelSelection("auto"), { id: "auto" });
});

test("resolveModelSelection: thinking overrides effort; catalog context option is honoured", () => {
  const sel = resolveModelSelection("claude-opus-5-5-medium", "xhigh", { context: "1m" });
  assert.deepEqual(sel.params, [{ id: "context", value: "1m" }, { id: "effort", value: "xhigh" }, { id: "fast", value: "false" }]);
  assert.equal(resolveModelSelection("claude-opus-5-5-medium", "off").params[1].value, "low");
  assert.equal(resolveModelSelection("claude-opus-5-5-medium", "adaptive").params[1].value, "medium");
  assert.equal(resolveModelSelection("claude-opus-5-5-medium", "bogus").params[1].value, "medium");
});

test("effort-less refs: /think decides the effort, default medium, ultra -> max", () => {
  const effortOf = (sel) => sel.params.find((p) => p.id === "effort")?.value;
  assert.equal(effortOf(resolveModelSelection("claude-opus-5-5")), "medium");
  assert.equal(effortOf(resolveModelSelection("claude-opus-5-5", "high")), "high");
  assert.equal(effortOf(resolveModelSelection("claude-opus-5-5", "xhigh")), "xhigh");
  assert.equal(effortOf(resolveModelSelection("claude-opus-5-5", "ultra")), "max");
  assert.equal(effortOf(resolveModelSelection("claude-opus-5-5", undefined, { effort: "high" })), "high");
  assert.equal(effortOf(resolveModelSelection("claude-opus-5-5-high", "low")), "low"); // /think beats the suffix
  assert.equal(describeModelSelection(resolveModelSelection("claude-opus-5-5", "high")), "claude-opus-5-5 context=300k effort=high");
});

test("model catalog: one effort-less Opus row with exactly Cursor's thinking levels", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const rows = manifest.modelCatalog.providers["cursor-cli"].models;
  assert.deepEqual(rows.map((r) => r.id), ["claude-opus-5-5"]);
  const base = rows[0];
  assert.ok(!base.status);
  assert.equal(base.contextWindow, 300000);
  assert.deepEqual(base.thinkingLevelMap, { off: null, minimal: null, xhigh: "xhigh", max: "max" }); // /think offers exactly low..max
  // Old effort-suffixed ids are declared as replaced (and still accepted at runtime by resolveModelSelection).
  assert.deepEqual(base.replaces, ["claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-opus-5-5-high", "claude-opus-5-5-xhigh", "claude-opus-5-5-max"]);
});

test("normalizeFinalText only collapses NO_REPLY variants after a messaging tool call", () => {
  assert.equal(normalizeFinalText("NO_REPLY"), "NO_REPLY");
  assert.equal(normalizeFinalText("NO_REPLY  I already sent it", { messagedThisTurn: true }), "NO_REPLY");
  assert.equal(normalizeFinalText("NO_REPLY\nextra", { messagedThisTurn: true }), "NO_REPLY");
  assert.equal(normalizeFinalText("", { messagedThisTurn: true }), "NO_REPLY");
  assert.equal(normalizeFinalText("NO_REPLY is the token OpenClaw uses"), "NO_REPLY is the token OpenClaw uses");
  assert.equal(normalizeFinalText(""), "");
  assert.equal(normalizeFinalText("ok", { messagedThisTurn: true }), "ok");
});

test("usage: cache is not double counted and run totals are split per call", () => {
  assert.deepEqual(toClaudeUsage({ inputTokens: 44791, outputTokens: 275, cacheReadTokens: 41747, cacheWriteTokens: 3034 }), {
    input_tokens: 10, output_tokens: 275, cache_read_input_tokens: 41747, cache_creation_input_tokens: 3034,
  });
  const u = { input_tokens: 3000, output_tokens: 300, cache_read_input_tokens: 40000, cache_creation_input_tokens: 4000 };
  assert.equal(estimatePerCallUsage(u, 1), u);
  assert.deepEqual(estimatePerCallUsage(u, 4), { input_tokens: 750, output_tokens: 75, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000 });
  assert.equal(estimatePerCallUsage(undefined, 3), undefined);
  assert.equal(estimatePerCallUsage(u, 0), u);
});

test("isRetryableAuthError matches Cursor auth failures only", () => {
  assert.equal(isRetryableAuthError("Authentication error If you are logged in, try logging out and back in."), true);
  assert.equal(isRetryableAuthError("[unauthenticated] token expired"), true);
  assert.equal(isRetryableAuthError("HTTP 401"), true);
  assert.equal(isRetryableAuthError("Model not available This model provider is not supported in your region."), false);
  assert.equal(isRetryableAuthError("rate limit exceeded"), false);
  assert.equal(isRetryableAuthError(undefined), false);
});

// ---------------------------------------------------------------- SDK execute (fake SDK)

test("execute: streams text, reports init tools and a terminal result", async () => {
  const { sdk, state } = fakeSdk([{ events: [{ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }], result: { status: "finished", result: "hello" } }]);
  const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }) });
  const out = await collect(exec(baseCtx({ systemPrompt: "SYS" })));
  assert.equal(out[0].type, "system");
  assert.deepEqual(out[0].tools, [...CURSOR_NATIVE_TOOL_NAMES]);
  assert.equal(out.at(-1).type, "result");
  assert.equal(out.at(-1).result, "hello");
  assert.match(state.sends[0].message, /<system_instructions>\nSYS/);
});

test("execute: auth error before any progress is retried once (status error and thrown)", async () => {
  for (const first of [{ result: { status: "error", error: { message: "Authentication error If you are logged in, try logging out and back in." } } }, { throwOnSend: "Authentication error" }]) {
    const { sdk, state } = fakeSdk([first, { result: { status: "finished", result: "ok" } }]);
    const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }) });
    const out = await collect(exec(baseCtx()));
    assert.equal(out.at(-1).result, "ok");
    assert.equal(state.sends.length, 2);
    assert.equal(state.resumed, 1);
    assert.equal(state.agents[0].closed, true);
    // The old agent is fully disposed (its executor and cached token dropped) before the
    // retry reopens it, so the retry exchanges the API key again.
    assert.equal(state.agents[0].disposed, true);
    const i = state.events.indexOf(`disposed:${state.agents[0].agentId}`);
    assert.ok(i >= 0 && state.events.indexOf(`resumed:${state.agents[0].agentId}`, 0) > i);
  }
});

test("execute: the timing line reports time spent inside agent.send apart from the wait for the first event", async () => {
  const text = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
  const timingOf = (logs) => {
    const line = logs.find((m) => m.startsWith("cursor-cli: timing")) ?? "";
    return { line, send: Number(/ send=(\d+)/.exec(line)?.[1]), first: Number(/ first=(\d+)/.exec(line)?.[1]) };
  };
  {
    const logs = [];
    const { sdk } = fakeSdk([{ sendDelayMs: 40, firstEventDelayMs: 80, events: [text], result: { status: "finished", result: "hi" } }]);
    await collect(createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }), log: (m) => logs.push(m) })(baseCtx()));
    const t = timingOf(logs);
    assert.ok(t.send >= 35 && t.send < 80, t.line); // the 40 ms send, not the 80 ms wait after it
    assert.ok(t.first >= t.send + 75, t.line);
    assert.match(t.line, / attempts=- /);
  }
  {
    // An auth retry sends twice; the mark sums both calls.
    const logs = [];
    const { sdk } = fakeSdk([{ sendDelayMs: 30, throwOnSend: "Authentication error" }, { sendDelayMs: 30, events: [text], result: { status: "finished", result: "hi" } }]);
    await collect(createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }), log: (m) => logs.push(m) })(baseCtx()));
    assert.ok(timingOf(logs).send >= 55, timingOf(logs).line);
  }
});

test("execute: the timing line counts the Cursor stream attempts of the turn's runs", async () => {
  const server = http.createServer((req, res) => req.resume().on("end", () => res.end()));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const text = { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } };
    await postRunSse(url, "another-run"); // not this turn's run
    const logs = [];
    // SDK-internal stall retries: four attempts that never connected, then one that worked.
    const { sdk } = fakeSdk([{ streamUrl: url, silentAttempts: 4, streamAttempts: 1, events: [text], result: { status: "finished", result: "hi" } }]);
    await collect(createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }), log: (m) => logs.push(m) })(baseCtx()));
    assert.match(logs.find((m) => m.startsWith("cursor-cli: timing")) ?? "", / send=\d+ first=\d+ attempts=5 /);
  } finally {
    server.close();
  }
});

test("execute: no retry once text or tools ran, and non-auth errors propagate", async () => {
  {
    const { sdk, state } = fakeSdk([{ events: [{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }], result: { status: "error", error: { message: "Authentication error" } } }]);
    const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }) });
    await assert.rejects(collect(exec(baseCtx())), /Authentication error/);
    assert.equal(state.sends.length, 1);
  }
  {
    const { sdk, state } = fakeSdk([{ result: { status: "error", error: { message: "rate limit" } } }]);
    const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }) });
    await assert.rejects(collect(exec(baseCtx())), /rate limit/);
    assert.equal(state.sends.length, 1);
  }
});

test("execute: aborting mid-run cancels the Cursor run", async () => {
  const { sdk, state } = fakeSdk([{ events: [{ type: "tool_call", name: "shell", call_id: "c1", status: "running" }], hang: true }]);
  const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }) });
  const ac = new AbortController();
  const done = collect(exec(baseCtx({ abortSignal: ac.signal })));
  await new Promise((r) => setTimeout(r, 20));
  ac.abort(new Error("user stop"));
  await assert.rejects(done, /user stop/);
  assert.equal(state.runs[0].cancelled, true);
});

test("execute: a consumer that stops early cancels the Cursor run", async () => {
  const { sdk, state } = fakeSdk([{ events: [{ type: "assistant", message: { content: [{ type: "text", text: "a" }] } }], hang: true }]);
  const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }) });
  const gen = exec(baseCtx());
  for await (const r of gen) if (r.type === "stream_event") break; // calls gen.return()
  assert.equal(state.runs[0].cancelled, true);
});

test("execute: an already-aborted signal never sends", async () => {
  const { sdk, state } = fakeSdk([{}]);
  const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }) });
  const ac = new AbortController();
  ac.abort(new Error("gone"));
  await assert.rejects(collect(exec(baseCtx({ abortSignal: ac.signal }))), /gone/);
  assert.equal(state.sends.length, 0);
});

test("execute: only allowed OpenClaw tools are registered and calls carry the turn grant", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const m = JSON.parse(body);
      seen.push({ method: m.method, auth: req.headers.authorization });
      const result = m.method === "tools/list"
        ? { tools: [{ name: "message", inputSchema: { type: "object" } }, { name: "automations", inputSchema: { type: "object" } }] }
        : m.method === "tools/call" ? { content: [{ type: "text", text: "sent" }] } : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccli-unit-"));
  const cfg = path.join(dir, "mcp.json");
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { openclaw: { url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: "Bearer turn-1" } } } }));
  try {
    const args = ["--strict-mcp-config", "--mcp-config", cfg];
    // No messaging call: a reply starting with the token is kept verbatim.
    {
      const { sdk, state } = fakeSdk([{ result: { status: "finished", result: "NO_REPLY  done" } }]);
      const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }) });
      const out = await collect(exec(baseCtx({ args, openClawAllow: new Set(["message"]) })));
      assert.deepEqual(Object.keys(state.sends[0].options.local.customTools), ["message"]);
      assert.equal(out.at(-1).result, "NO_REPLY  done");
    }
    // The model calls `message`: the call goes to OpenClaw with the turn grant and the
    // trailing commentary after NO_REPLY is dropped.
    {
      const { sdk } = fakeSdk([{ callTool: "message", result: { status: "finished", result: "NO_REPLY  I already sent it" } }]);
      const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }) });
      const out = await collect(exec(baseCtx({ args, openClawAllow: new Set(["message"]) })));
      assert.equal(out.at(-1).result, "NO_REPLY");
      assert.ok(seen.some((s) => s.method === "tools/call"));
    }
    assert.ok(seen.length > 0 && seen.every((s) => s.auth === "Bearer turn-1"));
    // message(final:true) delivered: the turn ends at once with NO_REPLY and the
    // still-running Cursor run (the NO_REPLY wrap-up call) is cancelled.
    {
      const { sdk, state } = fakeSdk([{ callTool: "message", callArgs: { action: "send", message: "答复", final: true }, events: [{ type: "tool_call", name: "mcp", call_id: "m1", status: "completed" }], hang: true }]);
      const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }) });
      const out = await collect(exec(baseCtx({ args, openClawAllow: new Set(["message"]) })));
      assert.equal(out.at(-1).type, "result");
      assert.equal(out.at(-1).result, "NO_REPLY");
      assert.equal(state.runs[0].cancelled, true);
    }
    // Progress updates (final:false) do not end the turn; the option can be turned off.
    {
      const { sdk, state } = fakeSdk([{ callTool: "message", callArgs: { action: "send", message: "进度", final: false }, events: [{ type: "tool_call", name: "mcp", call_id: "m2", status: "completed" }], result: { status: "finished", result: "done" } }]);
      const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }) });
      const out = await collect(exec(baseCtx({ args, openClawAllow: new Set(["message"]) })));
      assert.equal(out.at(-1).result, "done");
      assert.equal(state.runs[0].cancelled, false);
    }
    {
      const { sdk, state } = fakeSdk([{ callTool: "message", callArgs: { action: "send", message: "答复", final: true }, events: [{ type: "tool_call", name: "mcp", call_id: "m3", status: "completed" }], result: { status: "finished", result: "NO_REPLY" } }]);
      const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }), finishOnFinalMessage: false });
      const out = await collect(exec(baseCtx({ args, openClawAllow: new Set(["message"]) })));
      assert.equal(out.at(-1).result, "NO_REPLY");
      assert.equal(state.runs[0].cancelled, false);
    }
  } finally {
    server.close();
  }
});

test("AgentCache closes idle agents but not busy ones", () => {
  let t = 0;
  const cache = new AgentCache({ idleMs: 100, now: () => t });
  const a = { agentId: "a", closed: false, close() { this.closed = true; } };
  const b = { agentId: "b", closed: false, close() { this.closed = true; } };
  cache.set(a, "/w");
  cache.set(b, "/w");
  cache.acquire("b", "/w");
  t = 500;
  cache.sweep();
  assert.equal(a.closed, true);
  assert.equal(b.closed, false);
  assert.equal(cache.get("a", "/w"), undefined);
  assert.equal(cache.get("b", "/w"), b);
  assert.equal(cache.get("b", "/other"), undefined); // keyed by cwd too
  cache.closeAll();
  assert.equal(b.closed, true);
});

// ---------------------------------------------------------------- tool policy

test("native tool authority projection", () => {
  assert.deepEqual(projectCursorNativeToolAuthority(["read", "grep", "glob", "shell", "bogus"]).sort(), ["exec", "read"]);
  assert.deepEqual(projectCursorNativeToolAuthority(undefined), []);
});

test("tool availability planning: OpenClaw tools exact, native all-or-nothing, unknown tools fail closed", () => {
  resetObservedNativeToolsForTest();
  assert.deepEqual(planToolAvailability(undefined), { enforceable: true });
  const allNative = ["read", "edit", "write", "shell", "web_search", "web_fetch"];
  const full = planToolAvailability({ native: allNative, openClaw: ["message", "automations"] });
  assert.equal(full.enforceable, true);
  assert.deepEqual([...full.openClawAllow], ["message", "automations"]);
  const narrow = planToolAvailability({ native: ["read", "edit", "write", "web_search", "web_fetch"], openClaw: [] });
  assert.equal(narrow.enforceable, false);
  assert.match(narrow.reason, /exec/);
  assert.equal(planToolAvailability({ native: [], openClaw: ["message"] }).enforceable, false);

  assert.equal(observeNativeTool("mcp"), false); // the OpenClaw bridge is not native
  assert.equal(observeNativeTool("shell"), false);
  assert.equal(observeNativeTool("browser_use"), true);
  assert.equal(observeNativeTool("browser_use"), false);
  const blocked = planToolAvailability({ native: allNative, openClaw: [] });
  assert.equal(blocked.enforceable, false);
  assert.match(blocked.reason, /browser_use/);
  resetObservedNativeToolsForTest();
});

// ---------------------------------------------------------------- ACP helpers

test("ACP model ids: aliases, effort rewrite and thinking", () => {
  const available = [
    { modelId: "claude-opus-5-5[context=300k,effort=medium,fast=false]" },
    { modelId: "gpt-5.6-sol[context=272k,reasoning=medium,fast=false]" },
  ];
  assert.equal(resolveAcpModelId("claude-opus-5-5-high", available), "claude-opus-5-5[context=300k,effort=high,fast=false]");
  assert.equal(resolveAcpModelId("gpt-5.6-sol-low", available), "gpt-5.6-sol[context=272k,reasoning=low,fast=false]");
  assert.equal(resolveAcpModelId("x", available, { x: "y[a=b]" }), "y[a=b]");
  assert.equal(resolveAcpModelId("default", available), undefined);
  assert.equal(applyThinking("claude-opus-5-5[context=300k,effort=medium,fast=false]", "high"), "claude-opus-5-5[context=300k,effort=high,fast=false]");
  assert.equal(applyThinking("composer-2.5", "high"), "composer-2.5");
});

test("ACP permission picking prefers one-shot grants and never falls back to allow on reject", () => {
  const opts = [{ optionId: "aa", kind: "allow_always" }, { optionId: "ao", kind: "allow_once" }, { optionId: "ro", kind: "reject_once" }];
  assert.equal(pickPermissionOption(opts, true), "ao");
  assert.equal(pickPermissionOption(opts, false), "ro");
  assert.equal(pickPermissionOption([{ optionId: "aa", kind: "allow_always" }, { optionId: "deny", kind: "deny" }], false), "deny");
});

// ---------------------------------------------------------------- common helpers

test("childEnv keeps only allow-listed variables", () => {
  const env = childEnv({ PATH: "/bin", HOME: "/h", HTTPS_PROXY: "p", CURSOR_API_KEY: "k", AWS_SECRET_ACCESS_KEY: "s", OPENAI_API_KEY: "o", LC_ALL: "C" });
  assert.deepEqual(Object.keys(env).sort(), ["CURSOR_API_KEY", "HOME", "HTTPS_PROXY", "LC_ALL", "PATH"]);
});

test("readApiKey prefers the env var and reads + trims the key file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccli-key-"));
  const f = path.join(dir, "key");
  fs.writeFileSync(f, " secret-key \n", { mode: 0o600 });
  assert.equal(readApiKey({ CURSOR_API_KEY: "env" }, f), "env");
  assert.equal(readApiKey({}, f), "secret-key");
  assert.equal(readApiKey({}, undefined), undefined);
  const logs = [];
  fs.chmodSync(f, 0o644);
  readApiKey({}, f, (m) => logs.push(m));
  if (process.platform !== "win32") assert.match(logs.join(""), /chmod 600/);
});

// ---------------------------------------------------------------- MCP relay

test("MCP config helpers", () => {
  assert.deepEqual(extractMcpConfigPaths(["--strict-mcp-config", "--mcp-config", "/a.json", "/b.json", "--x"]), ["/a.json", "/b.json"]);
  assert.deepEqual(extractMcpConfigPaths(["--mcp-config=/c.json"]), ["/c.json"]);
  assert.deepEqual(toAcpMcpServer("s", { url: "http://h/mcp", headers: { A: "1" } }), { type: "http", name: "s", url: "http://h/mcp", headers: [{ name: "A", value: "1" }] });
  assert.deepEqual(toAcpMcpServer("s", { command: "node", args: ["x"], env: { K: "v" } }), { name: "s", command: "node", args: ["x"], env: [{ name: "K", value: "v" }] });
  assert.equal(toAcpMcpServer("s", {}), undefined);
});

test("MCP relay: rejects outside a turn, forwards with the turn grant, forgets deleted routes", async () => {
  let seen;
  const upstream = http.createServer((req, res) => {
    seen = { auth: req.headers.authorization, key: req.headers["x-k"] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const relay = new McpRelay();
  await relay.start();
  const route = relay.newRoute();
  const url = relay.urlFor(route);
  try {
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 503);
    assert.equal((await fetch(url.replace(relay.secret, "x".repeat(relay.secret.length)), { method: "POST", body: "{}" })).status, 404);
    assert.equal((await fetch(url.replace(relay.secret, "short"), { method: "POST", body: "{}" })).status, 404);
    relay.setTarget(route, { url: `http://127.0.0.1:${upstream.address().port}/mcp`, headers: { Authorization: "Bearer t1", "x-k": "k1" } });
    const res = await fetch(url, { method: "POST", body: "{}", headers: { authorization: "Bearer client" } });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, { auth: "Bearer t1", key: "k1" });
    relay.setTarget(route, null);
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 503);
    relay.deleteRoute(route);
    relay.setTarget(route, { url: "http://127.0.0.1:1/x", headers: {} }); // ignored for deleted routes
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 404);
  } finally {
    upstream.close();
    relay.server.close();
  }
});

// ---------------------------------------------------------------- packaging

test("package.json and openclaw.plugin.json agree on version; config schema covers README options", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.id, "cursor-cli");
  const props = Object.keys(manifest.configSchema.properties);
  for (const opt of ["apiKeyFile", "transport", "useHttp1", "modelDefaults", "agentIdleMinutes", "finishOnFinalMessage", "force", "command", "acpModelAliases"]) assert.ok(props.includes(opt), opt);
  assert.equal(manifest.configSchema.additionalProperties, false);
});

// ---------------------------------------------------------------- backend shape

test("backend shape matches the transport", async () => {
  resetObservedNativeToolsForTest();
  const sdk = buildCursorCliBackend({});
  assert.equal(sdk.id, "cursor-cli");
  assert.equal(sdk.nativeToolMode, "selectable");
  assert.equal(sdk.toolAvailabilityEnforcement, "prepare-execution");
  assert.equal(sdk.projectNativeToolAuthority, projectCursorNativeToolAuthority);
  assert.equal(sdk.sideQuestionToolMode, undefined); // Cursor cannot run with zero native tools
  assert.equal(sdk.bundleMcp, true);
  assert.equal(sdk.bundleMcpMode, "claude-config-file");
  assert.equal(sdk.ownsNativeCompaction, true);
  assert.equal(sdk.config.jsonlDialect, "claude-stream-json");
  assert.equal(sdk.config.reseedFromRawTranscriptWhenUncompacted, true);
  // serialize=true would queue every cursor-cli run (all sessions) behind one key.
  assert.equal(sdk.config.serialize, false);
  assert.equal(sdk.config.imageArg, "--openclaw-image");

  const open = await sdk.prepareExecution({ workspaceDir: "/w", provider: "cursor-cli", modelId: "m" });
  assert.equal(typeof open.execute, "function");
  assert.equal(open.toolAvailabilityEnforced, undefined);
  const capped = await sdk.prepareExecution({ workspaceDir: "/w", provider: "cursor-cli", modelId: "m", toolAvailability: { native: [...CURSOR_NATIVE_TOOL_NAMES], openClaw: ["message"] } });
  assert.equal(capped.toolAvailabilityEnforced, true);
  await assert.rejects(sdk.prepareExecution({ workspaceDir: "/w", provider: "cursor-cli", modelId: "m", toolAvailability: { native: ["read"], openClaw: [] } }), /cannot enforce/);
  await assert.rejects(sdk.prepareExecution({ workspaceDir: "/w", provider: "cursor-cli", modelId: "m", executionMode: "side-question", toolAvailability: { native: [], openClaw: [] } }), /cannot enforce/);

  const acp = buildCursorCliBackend({ transport: "acp" });
  assert.equal(acp.nativeToolMode, "always-on");
  assert.equal(typeof acp.prepareExecution, "function");
  assert.equal(acp.projectNativeToolAuthority, undefined);
  assert.equal(acp.sideQuestionToolMode, undefined);

  const print = buildCursorCliBackend({ transport: "print" });
  assert.equal(print.nativeToolMode, "always-on");
  assert.equal(print.prepareExecution, undefined);
  assert.equal(print.bundleMcp, undefined);
  assert.equal(print.config.imageArg, undefined);

  const warnings = [];
  buildCursorCliBackend({ force: false }, (m) => warnings.push(m));
  assert.match(warnings.join(""), /force=false has no effect/);
});

test("duplicate module loads share one agent cache (no re-resume on the second copy)", async () => {
  const copyA = await import("../lib/sdk-runtime.js?copy=a");
  const copyB = await import("../lib/sdk-runtime.js?copy=b");
  assert.notEqual(copyA.createSdkExecute, copyB.createSdkExecute); // really two module instances
  const { sdk, state } = fakeSdk([{ result: { status: "finished", result: "one" } }, { result: { status: "finished", result: "two" } }]);
  const ctx = () => baseCtx({ useResume: true, sessionId: "shared-session", cwd: "/tmp/dup-load" });
  // agentIdleMs used to give each backend build a private cache; it now tunes the shared one.
  const execA = copyA.createSdkExecute({ sdk, agentIdleMs: 60 * 60 * 1000 });
  const execB = copyB.createSdkExecute({ sdk, agentIdleMs: 60 * 60 * 1000 });
  assert.equal((await collect(execA(ctx()))).at(-1).result, "one");
  assert.equal((await collect(execB(ctx()))).at(-1).result, "two");
  assert.equal(state.resumed, 1);
  assert.equal(new Set(state.sends.map((s) => s.agentId)).size, 1);
});

// ---------------------------------------------------------------- compaction, state, prewarm

const SUMMARY = `User prefers Chinese replies. Goal: ship 0.4.7. Paths: /tmp/x. ${"detail ".repeat(40)}`;

test("SessionState: aliases chain, seeds and tool lists survive a reload; no secrets needed", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ccli-ss-")), "s.json");
  let t = 1000;
  const s = new SessionState({ file, now: () => t });
  s.noteAgent("a1", "/w", { id: "m" });
  s.setAlias("a1", "a2");
  s.setAlias("a2", "a3");
  s.setSeed("a3", "sum");
  s.setTools("k", [{ name: "message" }]);
  s.noteAgent("a3", "/w", { id: "m" });
  s.flush();
  const r = new SessionState({ file, now: () => t });
  assert.equal(r.resolve("a1"), "a3");
  assert.equal(r.resolve("zz"), "zz");
  assert.equal(r.seed("a3"), "sum");
  assert.deepEqual(r.tools("k"), [{ name: "message" }]);
  assert.deepEqual(r.recentAgents(10_000).map((a) => a.agentId), ["a3"]); // compacted a1 is not reopened
  t += 20_000;
  assert.deepEqual(r.recentAgents(10_000), []);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
});

test("compaction prompt and seed wrapper", () => {
  assert.match(buildCompactionPrompt(), /Do not use any tools/);
  assert.match(buildCompactionPrompt("keep the file paths"), /Additional instructions from the user: keep the file paths/);
  assert.match(wrapWithSeed("S", "hi"), /^<conversation_summary>[\s\S]*S\n<\/conversation_summary>\n\nhi$/);
  assert.equal(contextTokens({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }), 115);
  assert.equal(contextTokens(undefined), undefined);
});

test("backend declares manual compaction and validates the compact_boundary event", () => {
  const b = buildCursorCliBackend({ prewarm: false });
  assert.equal(b.ownsNativeCompaction, true);
  assert.equal(b.manualCompaction.buildPrompt(), "/compact");
  assert.equal(b.manualCompaction.buildPrompt(" keep paths "), "/compact keep paths");
  assert.deepEqual(validateCompactOutput('{"type":"system","subtype":"init"}\n{"type":"system","subtype":"compact_boundary"}'), { ok: true });
  assert.equal(validateCompactOutput('{"type":"result","result":"hi"}').ok, false);
  assert.equal(buildCursorCliBackend({ transport: "acp", prewarm: false }).manualCompaction, undefined);
});

test("/compact summarises into a fresh agent; the next turn continues there with the summary", async () => {
  const { sdk, state } = fakeSdk([
    { events: [{ type: "assistant", message: { content: [{ type: "text", text: SUMMARY }] } }], result: { status: "finished", result: SUMMARY } },
    { result: { status: "finished", result: "after" } },
  ]);
  const ss = new SessionState();
  const cache = new AgentCache({ idleMs: 0 });
  const exec = createSdkExecute({ sdk, cache, state: ss });
  const out = await collect(exec(baseCtx({ useResume: true, sessionId: "old-1", prompt: "/compact keep paths", systemPrompt: "SYS" })));
  assert.equal(state.sends[0].agentId, "old-1");
  assert.equal(state.sends[0].options.mode, "plan");
  assert.match(state.sends[0].message, /continuation summary[\s\S]*keep paths/);
  const newId = "agent-1";
  assert.deepEqual(out.map((r) => r.subtype ?? r.type), ["init", "compact_boundary", "success"]);
  assert.equal(out[0].session_id, newId);
  assert.equal(validateCompactOutput(out.map((r) => JSON.stringify(r)).join("\n")).ok, true);
  assert.equal(ss.resolve("old-1"), newId);
  assert.equal(state.agents.find((a) => a.agentId === "old-1").closed, true);
  // OpenClaw may still hold the old id: the turn lands on the successor, with SYS + summary.
  const next = await collect(exec(baseCtx({ useResume: true, sessionId: "old-1", prompt: "继续", systemPrompt: "SYS" })));
  assert.equal(next[0].session_id, newId);
  assert.equal(state.sends[1].agentId, newId);
  assert.match(state.sends[1].message, /<system_instructions>\nSYS[\s\S]*<conversation_summary>[\s\S]*Goal: ship 0\.4\.7[\s\S]*继续$/);
  assert.equal(ss.seed(newId), undefined); // seed used once
  assert.equal(next.at(-1).result, "after");
});

test("/compact with a short or failed summary keeps the old agent", async () => {
  const { sdk, state } = fakeSdk([{ result: { status: "finished", result: "too short" } }]);
  const ss = new SessionState();
  const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }), state: ss });
  await assert.rejects(collect(exec(baseCtx({ useResume: true, sessionId: "keep-1", prompt: "/compact" }))), /summary too short/);
  assert.equal(ss.resolve("keep-1"), "keep-1");
  assert.equal(state.created, 0);
});

test("auto-compaction runs in the background past the threshold; the next turn waits for it", async () => {
  const usage = { inputTokens: 90_000, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const { sdk, state } = fakeSdk([
    { result: { status: "finished", result: "big", usage } },
    { events: [{ type: "assistant", message: { content: [{ type: "text", text: SUMMARY }] } }], result: { status: "finished", result: SUMMARY } },
    { result: { status: "finished", result: "small" } },
  ]);
  const ss = new SessionState();
  const logs = [];
  const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }), state: ss, autoCompactTokens: 80_000, compactDelayMs: 0, log: (m) => logs.push(m) });
  const first = await collect(exec(baseCtx({ useResume: true, sessionId: "auto-1" })));
  assert.equal(first.at(-1).result, "big");
  assert.match(logs.join("\n"), /ctx=90000/);
  await new Promise((r) => setTimeout(r, 5)); // let the background compaction start
  const second = await collect(exec(baseCtx({ useResume: true, sessionId: "auto-1" })));
  assert.equal(second.at(-1).result, "small");
  assert.equal(ss.resolve("auto-1"), "agent-1");
  assert.equal(state.sends[2].agentId, "agent-1");
  assert.match(logs.join("\n"), /compacted agent=auto-1 -> agent-1/);
});

test("auto-compaction threshold is a share of the context window, like Claude Code", async () => {
  const sel = (ctx) => resolveModelSelection("claude-opus-5-5-medium", undefined, ctx ? { context: ctx } : {});
  assert.equal(contextWindowTokens(sel()), 300_000);
  assert.equal(contextWindowTokens(sel("1m")), 1_000_000);
  assert.equal(contextWindowTokens({ id: "composer-2.5" }), undefined);
  assert.equal(autoCompactThreshold(sel(), { percent: 90 }), 270_000);
  assert.equal(autoCompactThreshold(sel("1m"), { percent: 90 }), 900_000);
  assert.equal(autoCompactThreshold(sel(), { percent: 90, tokens: 150_000 }), 150_000); // absolute wins
  assert.equal(autoCompactThreshold(sel(), {}), 0);
  assert.equal(autoCompactThreshold({ id: "composer-2.5" }, { percent: 90 }), 0); // unknown window: off
  // 107K (the slow WeChat session) stays; 280K of 300K compacts.
  const { sdk, state } = fakeSdk([
    { result: { status: "finished", result: "a", usage: { inputTokens: 107_000 } } },
    { result: { status: "finished", result: "b", usage: { inputTokens: 280_000 } } },
    { events: [{ type: "assistant", message: { content: [{ type: "text", text: SUMMARY }] } }], result: { status: "finished", result: SUMMARY } },
  ]);
  const ss = new SessionState();
  const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }), state: ss, autoCompactPercent: 90, compactDelayMs: 0 });
  await collect(exec(baseCtx({ useResume: true, sessionId: "pct-1" })));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ss.resolve("pct-1"), "pct-1");
  await collect(exec(baseCtx({ useResume: true, sessionId: "pct-1" })));
  for (let i = 0; i < 50 && ss.resolve("pct-1") === "pct-1"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(ss.resolve("pct-1"), "agent-1");
  assert.equal(state.sends.length, 3);
});

test("plugin default: compaction at 90% of the window, not at a fixed token count", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.match(manifest.configSchema.properties.autoCompactPercent.description, /default 90/);
});

test("below the threshold (or with it off) nothing is compacted", async () => {
  const usage = { inputTokens: 1000, outputTokens: 1 };
  const { sdk, state } = fakeSdk([{ result: { status: "finished", result: "a", usage } }, { result: { status: "finished", result: "b", usage: { inputTokens: 500_000 } } }]);
  const ss = new SessionState();
  const exec = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }), state: ss, autoCompactTokens: 80_000, compactDelayMs: 0 });
  await collect(exec(baseCtx({ useResume: true, sessionId: "q-1" })));
  const off = createSdkExecute({ sdk, cache: new AgentCache({ idleMs: 0 }), state: ss, compactDelayMs: 0 });
  await collect(off(baseCtx({ useResume: true, sessionId: "q-1" })));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(state.sends.length, 2);
  assert.equal(ss.resolve("q-1"), "q-1");
});

test("tool lists saved by a previous run are used on the first turn after a restart", async () => {
  const ss = new SessionState();
  const key = ToolListCache.key("/w", undefined);
  ss.setTools(key, [{ name: "message" }]);
  const cache = new ToolListCache();
  cache.persistTo(ss);
  let listed = 0;
  const r = await cache.get(key, async () => { listed += 1; return [{ name: "message" }, { name: "new" }]; });
  assert.equal(r.cached, true);
  assert.deepEqual(r.tools, [{ name: "message" }]);
  await new Promise((res) => setTimeout(res, 0));
  assert.equal(listed, 1); // refreshed in the background
  assert.deepEqual(ss.tools(key), [{ name: "message" }, { name: "new" }]);
});

test("prewarm reopens recent agents once per process", async () => {
  const { sdk, state } = fakeSdk([]);
  const ss = new SessionState();
  ss.noteAgent("warm-1", "/w", { id: "claude-opus-5-5" });
  ss.noteAgent("warm-2", "/w2", { id: "claude-opus-5-5" });
  const cache = new AgentCache({ idleMs: 0 });
  const r = await prewarmSdk({ sdk, cache, state: ss, apiKeyFile: undefined });
  assert.equal(r.agents, 2);
  assert.equal(state.resumed, 2);
  assert.ok(cache.get("warm-1", "/w"));
  assert.equal(await prewarmSdk({ sdk, cache, state: ss }), r); // second call is the same promise
});
