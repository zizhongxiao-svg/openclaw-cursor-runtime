// Cursor SDK transport for the OpenClaw cursor-cli backend (default).
//
// Each OpenClaw session maps to one long-lived local Cursor agent (`agentId` is the
// CLI session id OpenClaw stores). Agents stay in memory for the life of the
// gateway; after a restart they are reopened with Agent.resume.
//
// OpenClaw tools: every turn OpenClaw hands the CLI a --mcp-config file pointing
// at its loopback MCP server with that turn's grant (Bearer token + capture key).
// Cursor team policies may block MCP servers, so instead of giving Cursor an MCP
// server, the turn's OpenClaw tools are registered as SDK `customTools`; each
// call is forwarded to the loopback server with that turn's credentials. The tool
// surface and authority are therefore exactly what claude-cli gets.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractMcpConfigPaths } from "./mcp-relay.js";

export const IMAGE_ARG = "--openclaw-image";
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const THINKING_TO_EFFORT = { off: "low", minimal: "low", low: "low", medium: "medium", adaptive: "medium", high: "high", xhigh: "xhigh", max: "max" };
const TOOL_CALL_TIMEOUT_MS = 60 * 60 * 1000;

let sdkPromise;
function loadSdk(opts) {
  if (!sdkPromise) {
    sdkPromise = import("@cursor/sdk").then((sdk) => {
      if (opts.useHttp1 !== false) sdk.Cursor.configure({ local: { useHttp1ForAgent: true } });
      return sdk;
    });
  }
  return sdkPromise;
}

function readApiKey(env, apiKeyFile) {
  if (env.CURSOR_API_KEY) return env.CURSOR_API_KEY;
  if (!apiKeyFile) return undefined;
  return readFileSync(apiKeyFile.replace(/^~(?=\/)/u, os.homedir()), "utf8").trim();
}

/**
 * OpenClaw model id -> Cursor SDK ModelSelection.
 * `claude-opus-5-5-medium` -> { id: "claude-opus-5-5", params: [context=300k, effort=medium, fast=false] }.
 * A thinking level, when given, overrides the effort.
 */
export function resolveModelSelection(modelId, thinkingLevel, defaults = {}) {
  let id = String(modelId ?? "").trim();
  let effort;
  const parts = id.split("-");
  if (parts.length > 1 && EFFORTS.has(parts.at(-1))) { effort = parts.pop(); id = parts.join("-"); }
  if (THINKING_TO_EFFORT[thinkingLevel]) effort = THINKING_TO_EFFORT[thinkingLevel];
  if (!id || id === "auto" || id === "default") return { id: "auto" };
  const params = [];
  const context = defaults.context ?? (id.startsWith("claude-") ? "300k" : undefined);
  if (context) params.push({ id: "context", value: context });
  if (effort) params.push({ id: "effort", value: effort });
  if (id.startsWith("claude-")) params.push({ id: "fast", value: "false" });
  return params.length ? { id, params } : { id };
}

function extractImages(args, log) {
  const out = [];
  for (let i = 0; i < (args?.length ?? 0); i += 1) {
    if (args[i] !== IMAGE_ARG || !args[i + 1]) continue;
    const p = args[++i];
    try { out.push({ data: readFileSync(p).toString("base64"), mimeType: IMAGE_MIME[path.extname(p).toLowerCase()] ?? "image/png" }); }
    catch (err) { log?.(`cursor-cli: cannot read image ${p}: ${err.message}`); }
  }
  return out;
}

function readLoopback(args, log) {
  for (const file of extractMcpConfigPaths(args)) {
    try {
      const server = JSON.parse(readFileSync(file, "utf8"))?.mcpServers?.openclaw;
      if (server && typeof server.url === "string") return { url: server.url, headers: server.headers ?? {} };
    } catch (err) { log?.(`cursor-cli: cannot read MCP config ${file}: ${err.message}`); }
  }
  return undefined;
}

/** Minimal JSON-RPC client for OpenClaw's loopback MCP server (JSON or SSE replies). */
class LoopbackClient {
  constructor({ url, headers }, signal) {
    this.url = url;
    this.headers = headers;
    this.signal = signal;
    this.nextId = 0;
  }

  async rpc(method, params, timeoutMs = 120000) {
    const id = ++this.nextId;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Error(`OpenClaw MCP ${method} timed out`)), timeoutMs);
    const onAbort = () => ctl.abort(this.signal.reason);
    this.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...this.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: ctl.signal,
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`OpenClaw MCP ${method} HTTP ${res.status}: ${body.slice(0, 300)}`);
      let msg;
      if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        for (const line of body.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try { const m = JSON.parse(line.slice(5)); if (m.id === id) msg = m; } catch {}
        }
      } else {
        const parsed = body ? JSON.parse(body) : undefined;
        msg = Array.isArray(parsed) ? parsed.find((m) => m.id === id) : parsed;
      }
      if (!msg) throw new Error(`OpenClaw MCP ${method}: empty response`);
      if (msg.error) throw new Error(`OpenClaw MCP ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
      return msg.result;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", onAbort);
    }
  }

  async listTools() {
    try { await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openclaw-cursor-cli", version: "0.3.0" } }); } catch {}
    const tools = [];
    let cursor;
    do {
      const r = await this.rpc("tools/list", cursor ? { cursor } : {});
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
    } while (cursor);
    return tools;
  }
}

function toSdkToolResult(result) {
  const content = [];
  for (const block of result?.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
    else if (block?.type === "image" && typeof block.data === "string") content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    else if (block) content.push({ type: "text", text: JSON.stringify(block) });
  }
  if (!content.length && result?.structuredContent) content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  return { content: content.length ? content : [{ type: "text", text: "" }], isError: result?.isError === true };
}

/** Build SDK customTools that forward to the turn's OpenClaw loopback MCP server. */
async function buildCustomTools(client, log) {
  let tools;
  try { tools = await client.listTools(); }
  catch (err) { log?.(`cursor-cli: OpenClaw tools unavailable this turn: ${err.message}`); return undefined; }
  const customTools = {};
  for (const tool of tools) {
    if (!tool?.name) continue;
    customTools[tool.name] = {
      description: tool.description ?? `OpenClaw tool ${tool.name}`,
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      execute: async (args) => {
        try { return toSdkToolResult(await client.rpc("tools/call", { name: tool.name, arguments: args ?? {} }, TOOL_CALL_TIMEOUT_MS)); }
        catch (err) { return { content: [{ type: "text", text: `OpenClaw tool ${tool.name} failed: ${err.message}` }], isError: true }; }
      },
    };
  }
  return Object.keys(customTools).length ? customTools : undefined;
}

function buildPromptText({ systemPrompt, prompt, promptContext, isNew }) {
  const parts = [];
  if (isNew && systemPrompt) parts.push(`<system_instructions>\n${systemPrompt}\n</system_instructions>`);
  if (promptContext?.prependContext) parts.push(promptContext.prependContext);
  parts.push(prompt ?? "");
  if (promptContext?.appendContext) parts.push(promptContext.appendContext);
  return parts.join("\n\n");
}

function toClaudeUsage(u) {
  if (!u) return undefined;
  // Cursor's inputTokens already includes cache reads/writes; Claude's input_tokens
  // excludes them (OpenClaw adds the cache fields back), so subtract to avoid double counting.
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  return {
    input_tokens: Math.max(0, (u.inputTokens ?? 0) - cacheRead - cacheWrite),
    output_tokens: u.outputTokens ?? 0,
    cache_read_input_tokens: u.cacheReadTokens ?? 0,
    cache_creation_input_tokens: u.cacheWriteTokens ?? 0,
  };
}

const agents = new Map(); // agentId -> SDKAgent (lives as long as the gateway)

/**
 * @param {{ apiKeyFile?: string, useHttp1?: boolean, modelDefaults?: { context?: string }, log?: (m: string) => void }} opts
 */
export function createSdkExecute(opts = {}) {
  return async function* execute(ctx) {
    const sdk = await loadSdk(opts);
    const env = { ...process.env, ...ctx.env };
    const apiKey = readApiKey(env, opts.apiKeyFile);
    const cwd = ctx.cwd || process.cwd();
    const sideQuestion = ctx.executionMode === "side-question";
    const model = resolveModelSelection(ctx.modelId, ctx.thinkingLevel, opts.modelDefaults);
    const loopback = readLoopback(ctx.args, opts.log);
    const turnAbort = new AbortController();
    const onAbort = () => turnAbort.abort(ctx.abortSignal?.reason);
    ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const customTools = loopback && !sideQuestion ? await buildCustomTools(new LoopbackClient(loopback, turnAbort.signal), opts.log) : undefined;
    const local = { cwd, settingSources: [] };

    let agent;
    let isNew = true;
    try {
      ctx.assertCurrent?.();
      if (!sideQuestion && ctx.useResume && ctx.sessionId) {
        agent = agents.get(ctx.sessionId);
        if (agent) isNew = false;
        else {
          try {
            agent = await sdk.Agent.resume(ctx.sessionId, { apiKey, model, local });
            agents.set(agent.agentId, agent);
            isNew = false;
          } catch (err) {
            opts.log?.(`cursor-cli: resume ${ctx.sessionId} failed (${err.message}); starting a new Cursor agent`);
          }
        }
      }
      if (!agent) {
        agent = await sdk.Agent.create({ apiKey, model, local, name: sideQuestion ? "openclaw side question" : "openclaw", ...(sideQuestion ? { mode: "plan" } : {}) });
        if (!sideQuestion) agents.set(agent.agentId, agent);
      }
      const agentId = agent.agentId;
      yield { type: "system", subtype: "init", session_id: agentId, model: model.id, cwd };

      const text = buildPromptText({ systemPrompt: ctx.systemPrompt, prompt: ctx.prompt, promptContext: ctx.promptContext, isNew });
      const images = extractImages(ctx.args, opts.log);
      const run = await agent.send(images.length ? { text, images } : text, {
        model,
        ...(sideQuestion ? { mode: "plan" } : {}),
        local: customTools ? { customTools } : {},
      });
      const cancel = () => { run.cancel().catch(() => {}); };
      turnAbort.signal.addEventListener("abort", cancel, { once: true });

      let streamed = "";
      let usage;
      let lastPing = 0;
      for await (const m of run.stream()) {
        if (m.type === "assistant") {
          for (const block of m.message?.content ?? []) {
            if (block?.type !== "text" || !block.text) continue;
            streamed += block.text;
            yield { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } }, session_id: agentId };
          }
        } else if (m.type === "usage") {
          usage = toClaudeUsage(m.usage);
        } else if (m.type === "tool_call" || m.type === "thinking" || m.type === "task") {
          if (Date.now() - lastPing > 5000) {
            lastPing = Date.now();
            yield { type: "stream_event", event: { type: "ping" }, session_id: agentId };
          }
        }
      }
      const result = await run.wait();
      if (result.status === "cancelled") throw new Error("Cursor run was cancelled");
      if (result.status === "error") throw new Error(`Cursor run failed: ${result.error?.message ?? "unknown error"}`);
      usage = toClaudeUsage(result.usage) ?? usage;
      const finalText = typeof result.result === "string" && result.result ? result.result : streamed;
      yield { type: "result", subtype: "success", is_error: false, result: finalText, session_id: agentId, ...(usage ? { usage } : {}) };
    } finally {
      ctx.abortSignal?.removeEventListener("abort", onAbort);
      if (!turnAbort.signal.aborted) turnAbort.abort(new Error("turn finished"));
      if (sideQuestion) try { agent?.close(); } catch {}
    }
  };
}
