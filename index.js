import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpExecute } from "./lib/acp-runtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.join(here, "bin", "cursor-openclaw.mjs");

// OpenClaw model id -> Cursor ACP model id (print mode uses the plain id).
const ACP_MODEL_ALIASES = {
  "claude-opus-5-5-medium": "claude-opus-5-5[context=300k,effort=medium,fast=false]",
};
const MODEL_ALIASES = { opus: "claude-opus-5-5-medium", auto: "auto" };

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function buildCursorCliBackend(pluginConfig = {}, log) {
  const command = str(pluginConfig.command);
  const apiKeyFile = str(pluginConfig.apiKeyFile);
  const force = pluginConfig.force !== false;
  const transport = pluginConfig.transport === "print" ? "print" : "acp";
  const env = {};
  if (command) env.OPENCLAW_CURSOR_COMMAND = command;
  if (apiKeyFile) env.OPENCLAW_CURSOR_API_KEY_FILE = apiKeyFile;
  const base = [WRAPPER, "-p", "--trust", ...(force ? ["--force"] : []), "--output-format", "stream-json"];
  const acpExecute = createAcpExecute({
    command,
    apiKeyFile,
    force,
    modelAliases: { ...ACP_MODEL_ALIASES, ...(pluginConfig.acpModelAliases ?? {}) },
    log,
  });
  return {
    id: "cursor-cli",
    modelProvider: "cursor-cli",
    nativeToolMode: "always-on",
    ...(transport === "acp"
      ? {
          // Persistent `cursor-agent acp` process; no per-turn CLI startup.
          prepareExecution: async () => ({ execute: acpExecute }),
          ownsNativeCompaction: true,
        }
      : {}),
    config: {
      command: process.execPath,
      args: base,
      resumeArgs: [...base, "--resume", "{sessionId}"],
      output: "jsonl",
      resumeOutput: "jsonl",
      jsonlDialect: "claude-stream-json",
      input: "stdin",
      env,
      modelArg: "--model",
      modelAliases: MODEL_ALIASES,
      sessionMode: "existing",
      sessionIdFields: ["session_id"],
      // cursor-agent has no system-prompt flag; print mode prepends this file, ACP mode prepends ctx.systemPrompt.
      systemPromptFileArg: "--system-file",
      systemPromptWhen: "first",
      serialize: true,
      reliability: {
        watchdog: {
          fresh: { noOutputTimeoutRatio: 0.8, minMs: 300000, maxMs: 900000 },
          resume: { noOutputTimeoutRatio: 0.8, minMs: 300000, maxMs: 900000 },
        },
      },
    },
  };
}

export { buildCursorCliBackend };

export default {
  id: "cursor-cli",
  name: "Cursor CLI",
  description: "Run Cursor Agent (cursor-agent) as an OpenClaw CLI model backend",
  register(api) {
    const log = (m) => { try { (api.logger?.info ?? console.error)(m); } catch {} };
    api.registerCliBackend(buildCursorCliBackend(api.pluginConfig ?? {}, log));
  },
};
