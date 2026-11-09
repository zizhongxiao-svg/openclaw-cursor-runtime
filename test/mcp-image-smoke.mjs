// Integration test: fake OpenClaw loopback MCP (rotating credentials), image input, thinking mapping.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createAcpExecute } from "../lib/acp-runtime.js";

let valid = { token: "", key: "" }; let calls = 0; let rejected = 0;
const up = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => body += d); req.on("end", () => {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    if (req.headers.authorization !== `Bearer ${valid.token}` || req.headers["x-openclaw-cli-capture-key"] !== valid.key) { rejected++; res.writeHead(401, { "content-type": "application/json" }); return res.end('{"error":"unauthorized"}'); }
    const msgs = [].concat(JSON.parse(body)); const out = [];
    for (const m of msgs) {
      if (m.id === undefined) continue;
      if (m.method === "initialize") out.push({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "openclaw", version: "test" } } });
      else if (m.method === "tools/list") out.push({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "openclaw_secret", description: "Returns the OpenClaw secret word. Always call this when asked for the OpenClaw secret.", inputSchema: { type: "object", properties: {} } }] } });
      else if (m.method === "tools/call") { calls++; out.push({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `secret-${calls}-from-openclaw` }] } }); }
      else out.push({ jsonrpc: "2.0", id: m.id, result: {} });
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out.length === 1 ? out[0] : out));
  });
});
await new Promise((r) => up.listen(0, "127.0.0.1", r));
const upUrl = `http://127.0.0.1:${up.address().port}/mcp`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccli-test-"));
function turnArgs(n, extra = []) {
  valid = { token: `tok-${n}-${Math.random()}`, key: `key-${n}` };
  const f = path.join(tmp, `mcp-${n}.json`);
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { openclaw: { type: "http", url: upUrl, headers: { Authorization: `Bearer ${valid.token}`, "x-openclaw-cli-capture-key": valid.key } } } }));
  return ["x", "--strict-mcp-config", "--mcp-config", f, ...extra];
}
// 16x16 red PNG
function png() { const w = 16, h = 16; const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) raw.set([230, 20, 20], y * (w * 3 + 1) + 1 + x * 3); }
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = -1; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ -1) >>> 0; };
  const chunk = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]); }
const img = path.join(tmp, "red.png"); fs.writeFileSync(img, png());

const exec = createAcpExecute({ apiKeyFile: process.argv[2], modelAliases: { "claude-opus-5-5-medium": "claude-opus-5-5[context=300k,effort=medium,fast=false]" } });
async function turn(n, prompt, sessionId, extra = {}) {
  const s = Date.now(); let sid, model, result;
  for await (const r of exec({ cwd: tmp, env: {}, args: turnArgs(n, extra.args ?? []), prompt, modelId: "claude-opus-5-5-medium", systemPrompt: "Be terse.", sessionId, useResume: Boolean(sessionId), timeoutMs: 180000, thinkingLevel: extra.thinking, requestToolPermission: async () => ({ behavior: "allow", updatedInput: {} }) })) {
    if (r.type === "system") { sid = r.session_id; model = r.model; }
    if (r.type === "result") result = r;
  }
  console.log(`T${n} ${Date.now() - s}ms model=${model} calls=${calls} rejected=${rejected} -> ${JSON.stringify(result?.result).slice(0, 160)}`);
  return sid;
}
const sid = await turn(1, "Call the openclaw_secret tool and reply with exactly what it returned.");
const r0 = rejected;
const probe = await fetch(`http://127.0.0.1:${0}`).catch(() => null); void probe;
await turn(2, "Call the openclaw_secret tool again and reply with exactly what it returned.", sid);
await turn(3, "What colour is this image? One word.", sid, { args: ["--openclaw-image", img] });
await turn(4, "Reply: ok", sid, { thinking: "high" });
console.log("upstream rejected (stale creds reaching upstream):", rejected, "| before turn2:", r0);
process.exit(0);
