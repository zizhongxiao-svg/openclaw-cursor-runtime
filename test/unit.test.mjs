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
} from "../lib/sdk-runtime.js";
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
import { buildCursorCliBackend } from "../index.js";

// ---------------------------------------------------------------- fake @cursor/sdk

/**
 * Each entry of `script` drives one agent.send():
 *   { throwOnSend?: string, events?: object[], hang?: boolean, result?: object }
 */
function fakeSdk(script) {
  const state = { created: 0, resumed: 0, sends: [], runs: [], agents: [] };
  class FakeRun {
    constructor(b) { this.b = b; this.cancelled = false; }
    async *stream() {
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
      if (b.throwOnSend) throw new Error(b.throwOnSend);
      if (b.callTool) b.toolResult = await options.local.customTools[b.callTool].execute(b.callArgs ?? { text: "hi" }, {});
      const run = new FakeRun(b);
      state.runs.push(run);
      return run;
    }
    close() { this.closed = true; }
  }
  const sdk = {
    Cursor: { configure() {} },
    Agent: {
      create: async () => { state.created += 1; return new FakeAgent(`agent-${state.created}`); },
      resume: async (id) => { state.resumed += 1; return new FakeAgent(id); },
    },
  };
  return { sdk, state };
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
