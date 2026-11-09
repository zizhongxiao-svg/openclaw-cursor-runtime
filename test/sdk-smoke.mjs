// Integration test for the SDK transport with a fake OpenClaw loopback MCP server (rotating creds).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createSdkExecute } from "../lib/sdk-runtime.js";

let valid = { token: "", key: "" }; let calls = 0; let rejected = 0;
const up = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => body += d); req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${valid.token}` || req.headers["x-openclaw-cli-capture-key"] !== valid.key) { rejected++; res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    const m = JSON.parse(body); let out;
    if (m.method === "initialize") out = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openclaw", version: "t" } };
    else if (m.method === "tools/list") out = { tools: [{ name: "message", description: "Send a message to the current chat. Use when asked to send/notify.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
    else if (m.method === "tools/call") { calls++; out = { content: [{ type: "text", text: `sent:${m.params.arguments.text}` }] }; }
    else out = {};
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: out }));
  });
});
await new Promise((r) => up.listen(0, "127.0.0.1", r));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccli-sdk-"));
function args(n, extra = []) {
  valid = { token: `tok-${n}-${Math.random()}`, key: `key-${n}` };
  const f = path.join(tmp, `mcp-${n}.json`);
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { openclaw: { type: "http", url: `http://127.0.0.1:${up.address().port}/mcp`, headers: { Authorization: `Bearer ${valid.token}`, "x-openclaw-cli-capture-key": valid.key } } } }));
  return ["--strict-mcp-config", "--mcp-config", f, ...extra];
}
function png() { const w = 16, h = 16; const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([20, 200, 40], y * (w * 3 + 1) + 1 + x * 3);
  const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  const crc = (b) => { let r = -1; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ -1) >>> 0; };
  const ch = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ch("IHDR", ih), ch("IDAT", zlib.deflateSync(raw)), ch("IEND", Buffer.alloc(0))]); }
const img = path.join(tmp, "green.png"); fs.writeFileSync(img, png());

let exec = createSdkExecute({ apiKeyFile: process.argv[2], log: (m) => console.log("LOG", m) });
async function turn(n, prompt, sessionId, x = {}) {
  const s = Date.now(); let sid, result, deltas = 0, text = "";
  for await (const r of exec({ cwd: tmp, env: {}, args: args(n, x.args), prompt, modelId: "claude-opus-5-5-medium", systemPrompt: "You are 小满. Start every reply with '小满：'.", sessionId, useResume: Boolean(sessionId), timeoutMs: 180000, thinkingLevel: x.thinking, executionMode: x.mode, requestToolPermission: async () => ({ behavior: "allow", updatedInput: {} }) })) {
    if (r.type === "system") sid = r.session_id;
    if (r.type === "stream_event" && r.event.type === "content_block_delta") { deltas++; text += r.event.delta.text; }
    if (r.type === "result") result = r;
  }
  const same = text.trim() === (result?.result ?? "").trim();
  console.log(`T${n} ${Date.now() - s}ms deltas=${deltas} streamed==result:${same} calls=${calls} rejected=${rejected} usage=${result?.usage?.input_tokens ?? "-"} -> ${JSON.stringify(result?.result).slice(0, 110)}`);
  return sid;
}
const sid = await turn(1, "Remember code word plum-3. Then use the message tool to send the text 'hello-1'. Reply with the tool result.");
await turn(2, "Use the message tool again to send 'hello-2'. Reply with the tool result.", sid);
await turn(3, "What colour is this image? One word.", sid, { args: ["--openclaw-image", img] });
await turn(4, "Reply: ok", sid, { thinking: "high" });
// simulate gateway restart: fresh module state is not possible here, so drop the cached agent by re-importing a fresh copy
const fresh = await import(`../lib/sdk-runtime.js?restart=${Date.now()}`);
exec = fresh.createSdkExecute({ apiKeyFile: process.argv[2] });
await turn(5, "What was the code word? Just it.", sid);
await turn(6, "In one sentence: what is 2+2?", undefined, { mode: "side-question" });
process.exit(0);
