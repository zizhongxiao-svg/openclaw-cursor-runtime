import { createAcpExecute, _closeAllForTest } from "../../lib/acp-runtime.js";
process.on("unhandledRejection", (e) => { console.log("UNHANDLED", e?.message); });
process.on("uncaughtException", (e) => { console.log("UNCAUGHT", e?.message); });
const exec = createAcpExecute({ apiKeyFile: process.argv[2] });
const ctx = { cwd: process.cwd(), env: {}, prompt: "Count slowly from 1 to 200, one number per line.", modelId: "claude-opus-5-5-medium", systemPrompt: "", useResume: false, timeoutMs: 120000, requestToolPermission: async () => ({ behavior: "allow", updatedInput: {} }) };
let n = 0;
try { for await (const r of exec(ctx)) { if (r.type === "stream_event" && ++n === 3) _closeAllForTest(true); } console.log("ended without error?!"); }
catch (e) { console.log("turn threw cleanly:", e.message); }
const s = Date.now(); let res;
for await (const r of exec({ ...ctx, prompt: "reply just: alive" })) if (r.type === "result") res = r.result;
console.log("next turn after crash:", Date.now() - s, "ms", JSON.stringify(res));
process.exit(0);
