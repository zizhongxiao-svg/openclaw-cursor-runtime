// Live check of finishOnFinalMessage: real Cursor, fake OpenClaw loopback with a
// `message` tool, and the "message(final:true) then NO_REPLY" reply rule.
// Usage: node test/live/early-finish.mjs <cursor-api-key-file>
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSdkExecute, AgentCache } from "../../lib/sdk-runtime.js";

let sent = [];
const up = http.createServer((req, res) => {
  let b = "";
  req.on("data", (d) => { b += d; });
  req.on("end", () => {
    const m = JSON.parse(b);
    let r = {};
    if (m.method === "tools/list") {
      r = { tools: [{ name: "message", description: "Send a message to the current chat. action=send; final=true for the terminal answer.", inputSchema: { type: "object", properties: { action: { type: "string" }, message: { type: "string" }, final: { type: "boolean" } }, required: ["action", "message"] } }] };
    } else if (m.method === "tools/call") {
      sent.push(m.params.arguments);
      r = { content: [{ type: "text", text: "sent ok" }] };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: r }));
  });
});
await new Promise((r) => up.listen(0, "127.0.0.1", r));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "early-"));
const cfg = path.join(dir, "mcp.json");
fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { openclaw: { url: `http://127.0.0.1:${up.address().port}/mcp`, headers: {} } } }));
const rule = "回复规则：最后一次工具调用必须是 message 工具 action=send, final=true，内容是给主人的完整中文答复；发完之后最终文本只输出 NO_REPLY。";

for (const early of [true, false]) {
  const exec = createSdkExecute({ apiKeyFile: process.argv[2], cache: new AgentCache({ idleMs: 0 }), finishOnFinalMessage: early });
  let sid;
  for (const [i, q] of ["你好", "在吗", "今天星期几？"].entries()) {
    sent = [];
    const s = Date.now();
    let res;
    for await (const r of exec({ cwd: dir, env: {}, args: ["--mcp-config", cfg], prompt: q, modelId: "claude-opus-5-5", systemPrompt: rule, sessionId: sid, useResume: Boolean(sid), timeoutMs: 120000, openClawAllow: new Set(["message"]) })) {
      if (r.type === "system") sid = r.session_id;
      if (r.type === "result") res = r;
    }
    console.log(`finishOnFinalMessage=${early} T${i + 1} ${Date.now() - s}ms result=${JSON.stringify(res.result)} sent=${JSON.stringify(sent.map((x) => [x.final, String(x.message ?? "").slice(0, 20)]))}`);
  }
}
up.close();
process.exit(0);
