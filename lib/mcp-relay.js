// Local MCP relay between a persistent Cursor ACP session and OpenClaw's
// per-turn loopback MCP server.
//
// OpenClaw mints a fresh MCP client grant (Bearer token + capture key) for every
// CLI turn and hands it over in a --mcp-config file. A long-lived Cursor session
// fixes its MCP server list when the session is opened, so it cannot pick up the
// new credentials. Cursor therefore talks to this relay at a stable URL; for the
// duration of each turn the relay forwards to that turn's OpenClaw endpoint with
// that turn's headers. Outside a turn every request gets 503, so a session can
// never reach OpenClaw tools without an admitted run.
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "authorization", "content-length"]);

export class McpRelay {
  constructor({ log } = {}) {
    this.log = log;
    this.secret = crypto.randomBytes(18).toString("base64url");
    this.routes = new Map(); // routeId -> { url, headers } | null
    this.server = undefined;
    this.port = undefined;
    this.starting = undefined;
  }

  async start() {
    if (this.port) return;
    if (!this.starting) {
      this.starting = new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => this.handle(req, res));
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
          this.server = server;
          this.port = server.address().port;
          server.unref();
          resolve();
        });
      });
    }
    await this.starting;
  }

  newRoute() {
    const id = crypto.randomBytes(12).toString("base64url");
    this.routes.set(id, null);
    return id;
  }

  urlFor(routeId) {
    return `http://127.0.0.1:${this.port}/${this.secret}/${routeId}`;
  }

  /** Point a route at the current turn's upstream (or null to close it). */
  setTarget(routeId, target) {
    this.routes.set(routeId, target ?? null);
  }

  handle(req, res) {
    const reject = (status, message) => {
      if (res.headersSent) return res.end();
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
    };
    const parts = (req.url ?? "/").split("?")[0].split("/").filter(Boolean);
    if (parts.length < 2 || parts[0] !== this.secret) return reject(404, "not found");
    const target = this.routes.get(parts[1]);
    if (target === undefined) return reject(404, "unknown route");
    if (target === null) return reject(503, "OpenClaw tools are only available during an active turn");

    let upstream;
    try { upstream = new URL(target.url); } catch { return reject(502, "bad upstream url"); }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    for (const [k, v] of Object.entries(target.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const mod = upstream.protocol === "https:" ? https : http;
    const out = mod.request(upstream, { method: req.method, headers }, (up) => {
      const resHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) if (!["connection", "keep-alive", "transfer-encoding"].includes(k)) resHeaders[k] = v;
      res.writeHead(up.statusCode ?? 502, resHeaders);
      up.pipe(res);
    });
    out.on("error", (err) => {
      this.log?.(`cursor-cli: MCP relay upstream error: ${err.message}`);
      reject(502, `upstream error: ${err.message}`);
    });
    req.on("aborted", () => out.destroy());
    res.on("close", () => { if (!res.writableEnded) out.destroy(); });
    req.pipe(out);
  }
}

/** Read every --mcp-config file value from an argv list (Claude variadic flag). */
export function extractMcpConfigPaths(args) {
  const paths = [];
  for (let i = 0; i < (args?.length ?? 0); i += 1) {
    const a = args[i];
    if (a === "--mcp-config") {
      for (let j = i + 1; j < args.length && !String(args[j]).startsWith("-"); j += 1) { paths.push(args[j]); i = j; }
    } else if (typeof a === "string" && a.startsWith("--mcp-config=")) paths.push(a.slice(13));
  }
  return paths;
}

/** Convert a Claude-style mcpServers map entry to an ACP McpServer. */
export function toAcpMcpServer(name, server) {
  if (!server || typeof server !== "object") return undefined;
  const headerList = (h) => Object.entries(h ?? {}).map(([k, v]) => ({ name: k, value: String(v) }));
  if (typeof server.url === "string") {
    const type = server.type === "sse" ? "sse" : "http";
    return { type, name, url: server.url, headers: headerList(server.headers) };
  }
  if (typeof server.command === "string") {
    return { name, command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [], env: headerList(server.env) };
  }
  return undefined;
}
