import { createAcpExecute, resolveAcpModelId, closeAllForTest } from "../../lib/acp-runtime.js";
process.on("unhandledRejection", (e) => console.log("UNHANDLED", e?.message, e?.stack?.split("\n").slice(0,6).join(" | ")));
const exec = createAcpExecute({ apiKeyFile: process.argv[2], modelAliases: { "claude-opus-5-5-medium": "claude-opus-5-5[context=300k,effort=medium,fast=false]" }, log: (m) => console.log("LOG", m) });
const ctl = new AbortController();
async function turn(prompt, sessionId) {
  const s = Date.now(); let sid, model, result, deltas = 0;
  for await (const r of exec({ cwd: process.cwd(), env: {}, prompt, modelId: "claude-opus-5-5-medium", systemPrompt: "You are 小满. Always start replies with '小满：'.", sessionId, useResume: Boolean(sessionId), abortSignal: ctl.signal, timeoutMs: 120000, requestToolPermission: async () => ({ behavior: "allow", updatedInput: {} }), requestUserInput: async () => ({ status: "cancelled", message: "" }) })) {
    if (r.type === "system") { sid = r.session_id; model = r.model; }
    if (r.type === "stream_event" && r.event.type === "content_block_delta") deltas++;
    if (r.type === "result") result = r;
  }
  console.log(`${Date.now() - s}ms sid=${sid?.slice(0, 8)} model=${model} deltas=${deltas} -> ${JSON.stringify(result.result)} ${result.subtype}`);
  return sid;
}
const sid = await turn("Remember the code word: banana-42. Reply in one short sentence.");
await turn("What is the code word? Reply with just it.", sid);
await turn("用 shell 执行 `echo hi-from-shell` 并告诉我输出", sid);
// simulate restart: kill the pooled process
closeAllForTest(true); await new Promise((r) => setTimeout(r, 1500));
await turn("Code word again? just it.", sid);
console.log("model map:", resolveAcpModelId("claude-sonnet-5-5-high", [{ modelId: "claude-sonnet-5-5[context=300k,reasoning_effort=high]" }]));
process.exit(0);
