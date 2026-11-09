import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.join(here, "bin", "cursor-openclaw.mjs");

const MODEL_ALIASES = {
  opus: "claude-opus-5-5-medium",
  auto: "auto",
};

function buildCursorCliBackend(pluginConfig = {}) {
  const env = {};
  if (typeof pluginConfig.command === "string" && pluginConfig.command.trim()) env.OPENCLAW_CURSOR_COMMAND = pluginConfig.command.trim();
  if (typeof pluginConfig.apiKeyFile === "string" && pluginConfig.apiKeyFile.trim()) env.OPENCLAW_CURSOR_API_KEY_FILE = pluginConfig.apiKeyFile.trim();
  const base = [WRAPPER, "-p", "--trust", ...(pluginConfig.force === false ? [] : ["--force"]), "--output-format", "stream-json"];
  return {
    id: "cursor-cli",
    modelProvider: "cursor-cli",
    nativeToolMode: "always-on",
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
      // cursor-agent has no system-prompt flag; the wrapper prepends this file to the prompt.
      systemPromptFileArg: "--system-file",
      systemPromptWhen: "first",
      serialize: true,
    },
  };
}

export { buildCursorCliBackend };

export default {
  id: "cursor-cli",
  name: "Cursor CLI",
  description: "Run Cursor Agent (cursor-agent) as an OpenClaw CLI model backend",
  register(api) {
    api.registerCliBackend(buildCursorCliBackend(api.pluginConfig ?? {}));
  },
};
