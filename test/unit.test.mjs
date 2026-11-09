// Offline unit tests: no Cursor account, network or OpenClaw gateway needed.
// Run with `npm test` (node --test).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { resolveModelSelection, normalizeFinalText, estimatePerCallUsage } from "../lib/sdk-runtime.js";
import { resolveAcpModelId, applyThinking } from "../lib/acp-runtime.js";
import { extractMcpConfigPaths, toAcpMcpServer, McpRelay } from "../lib/mcp-relay.js";
import { buildCursorCliBackend } from "../index.js";
import { planToolAvailability, projectCursorNativeToolAuthority, CURSOR_NATIVE_TOOL_NAMES } from "../lib/tool-policy.js";

test("resolveModelSelection maps effort-suffixed ids to SDK params", () => {
  assert.deepEqual(resolveModelSelection("claude-opus-5-5-medium"), {
    id: "claude-opus-5-5",
    params: [{ id: "context", value: "300k" }, { id: "effort", value: "medium" }, { id: "fast", value: "false" }],
  });
  assert.deepEqual(resolveModelSelection("gpt-5.6-sol-high"), { id: "gpt-5.6-sol", params: [{ id: "effort", value: "high" }] });
  assert.deepEqual(resolveModelSelection("composer-2.5"), { id: "composer-2.5" });
  assert.deepEqual(resolveModelSelection("auto"), { id: "auto" });
});

test("resolveModelSelection: thinking level overrides effort, context default is configurable", () => {
  const sel = resolveModelSelection("claude-opus-5-5-medium", "xhigh", { context: "1m" });
  assert.deepEqual(sel.params, [{ id: "context", value: "1m" }, { id: "effort", value: "xhigh" }, { id: "fast", value: "false" }]);
  assert.equal(resolveModelSelection("claude-opus-5-5-medium", "off").params[1].value, "low");
  assert.equal(resolveModelSelection("claude-opus-5-5-medium", "adaptive").params[1].value, "medium");
  assert.equal(resolveModelSelection("claude-opus-5-5-medium", "bogus").params[1].value, "medium");
});

test("normalizeFinalText collapses NO_REPLY variants", () => {
  assert.equal(normalizeFinalText("NO_REPLY"), "NO_REPLY");
  assert.equal(normalizeFinalText("NO_REPLY  I already sent it"), "NO_REPLY");
  assert.equal(normalizeFinalText("NO_REPLY\nextra"), "NO_REPLY");
  assert.equal(normalizeFinalText("", { messagedThisTurn: true }), "NO_REPLY");
  assert.equal(normalizeFinalText(""), "");
  assert.equal(normalizeFinalText("hello NO_REPLY"), "hello NO_REPLY");
  assert.equal(normalizeFinalText("ok", { messagedThisTurn: true }), "ok");
});

test("estimatePerCallUsage divides a run total across model calls", () => {
  const u = { input_tokens: 3000, output_tokens: 300, cache_read_input_tokens: 40000, cache_creation_input_tokens: 4000 };
  assert.equal(estimatePerCallUsage(u, 1), u);
  assert.deepEqual(estimatePerCallUsage(u, 4), { input_tokens: 750, output_tokens: 75, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000 });
  assert.equal(estimatePerCallUsage(undefined, 3), undefined);
  assert.equal(estimatePerCallUsage(u, 0), u);
});

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

test("MCP config helpers", () => {
  assert.deepEqual(extractMcpConfigPaths(["--strict-mcp-config", "--mcp-config", "/a.json", "/b.json", "--x"]), ["/a.json", "/b.json"]);
  assert.deepEqual(extractMcpConfigPaths(["--mcp-config=/c.json"]), ["/c.json"]);
  assert.deepEqual(toAcpMcpServer("s", { url: "http://h/mcp", headers: { A: "1" } }), { type: "http", name: "s", url: "http://h/mcp", headers: [{ name: "A", value: "1" }] });
  assert.deepEqual(toAcpMcpServer("s", { command: "node", args: ["x"], env: { K: "v" } }), { name: "s", command: "node", args: ["x"], env: [{ name: "K", value: "v" }] });
  assert.equal(toAcpMcpServer("s", {}), undefined);
});

test("MCP relay rejects requests outside an active turn and forwards during one", async () => {
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
    assert.equal((await fetch(url.replace(relay.secret, "wrong"), { method: "POST", body: "{}" })).status, 404);
    relay.setTarget(route, { url: `http://127.0.0.1:${upstream.address().port}/mcp`, headers: { Authorization: "Bearer t1", "x-k": "k1" } });
    const res = await fetch(url, { method: "POST", body: "{}", headers: { authorization: "Bearer client" } });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, { auth: "Bearer t1", key: "k1" });
    relay.setTarget(route, null);
    assert.equal((await fetch(url, { method: "POST", body: "{}" })).status, 503);
  } finally {
    upstream.close();
    relay.server.close();
  }
});

test("backend shape matches the transport", async () => {
  const sdk = buildCursorCliBackend({});
  assert.equal(sdk.id, "cursor-cli");
  assert.equal(sdk.nativeToolMode, "selectable");
  assert.equal(sdk.toolAvailabilityEnforcement, "prepare-execution");
  assert.equal(sdk.projectNativeToolAuthority, projectCursorNativeToolAuthority);
  assert.equal(sdk.bundleMcp, true);
  assert.equal(sdk.bundleMcpMode, "claude-config-file");
  assert.equal(sdk.ownsNativeCompaction, true);
  assert.equal(sdk.config.jsonlDialect, "claude-stream-json");
  assert.equal(sdk.config.reseedFromRawTranscriptWhenUncompacted, true);
  assert.equal(sdk.config.imageArg, "--openclaw-image");

  const open = await sdk.prepareExecution({ workspaceDir: "/w", provider: "cursor-cli", modelId: "m" });
  assert.equal(typeof open.execute, "function");
  assert.equal(open.toolAvailabilityEnforced, undefined);
  const capped = await sdk.prepareExecution({ workspaceDir: "/w", provider: "cursor-cli", modelId: "m", toolAvailability: { native: CURSOR_NATIVE_TOOL_NAMES, openClaw: ["message"] } });
  assert.equal(capped.toolAvailabilityEnforced, true);
  await assert.rejects(sdk.prepareExecution({ workspaceDir: "/w", provider: "cursor-cli", modelId: "m", toolAvailability: { native: ["Read"], openClaw: [] } }), /cannot enforce/);
  const btw = await sdk.prepareExecution({ workspaceDir: "/w", provider: "cursor-cli", modelId: "m", executionMode: "side-question", toolAvailability: { native: [], openClaw: [] } });
  assert.equal(typeof btw.execute, "function");

  const acp = buildCursorCliBackend({ transport: "acp" });
  assert.equal(acp.nativeToolMode, "always-on");
  assert.equal(typeof acp.prepareExecution, "function");
  assert.equal(acp.projectNativeToolAuthority, undefined);

  const print = buildCursorCliBackend({ transport: "print" });
  assert.equal(print.nativeToolMode, "always-on");
  assert.equal(print.prepareExecution, undefined);
  assert.equal(print.bundleMcp, undefined);
  assert.equal(print.config.imageArg, undefined);
});

test("native tool authority projection", () => {
  assert.deepEqual(projectCursorNativeToolAuthority(["Read", "Grep", "Glob", "Shell", "Bogus"]).sort(), ["exec", "read"]);
  assert.deepEqual(projectCursorNativeToolAuthority(undefined), []);
});

test("tool availability planning: OpenClaw tools exact, native all-or-nothing", () => {
  assert.deepEqual(planToolAvailability(undefined), { enforceable: true });
  const full = planToolAvailability({ native: ["Read", "Write", "StrReplace", "Shell", "WebSearch", "WebFetch"], openClaw: ["message", "automations"] });
  assert.equal(full.enforceable, true);
  assert.deepEqual([...full.openClawAllow], ["message", "automations"]);
  const narrow = planToolAvailability({ native: ["Read", "Write", "StrReplace", "WebSearch", "WebFetch"], openClaw: [] });
  assert.equal(narrow.enforceable, false);
  assert.match(narrow.reason, /exec/);
  assert.equal(planToolAvailability({ native: [], openClaw: ["message"] }).enforceable, false);
});

test("context window option from the catalog reaches the SDK model params", () => {
  assert.deepEqual(resolveModelSelection("claude-opus-5-5-high", undefined, { context: "1m" }).params[0], { id: "context", value: "1m" });
});
