import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAcpExecute } from "./lib/acp-runtime.js";
import { createSdkExecute } from "./lib/sdk-runtime.js";
import { IMAGE_ARG } from "./lib/common.js";
import { planToolAvailability, projectCursorNativeToolAuthority } from "./lib/tool-policy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.join(here, "bin", "cursor-openclaw.mjs");

// OpenClaw model id -> Cursor ACP model id (print mode uses the plain id).
const ACP_MODEL_ALIASES = {
  "claude-opus-5-5": "claude-opus-5-5[context=300k,effort=medium,fast=false]",
  "claude-opus-5-5-medium": "claude-opus-5-5[context=300k,effort=medium,fast=false]",
};
const MODEL_ALIASES = { opus: "claude-opus-5-5-medium", "claude-opus-5-5": "claude-opus-5-5-medium", auto: "auto" };

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function buildCursorCliBackend(pluginConfig = {}, log) {
  const command = str(pluginConfig.command);
  const apiKeyFile = str(pluginConfig.apiKeyFile);
  const force = pluginConfig.force !== false;
  const transport = ["print", "acp"].includes(pluginConfig.transport) ? pluginConfig.transport : "sdk";
  if (!force && transport === "sdk") {
    log?.("cursor-cli: force=false has no effect with transport \"sdk\" (the Cursor SDK does not surface permission prompts); use transport \"acp\" to route prompts to OpenClaw");
  }
  const env = {};
  if (command) env.OPENCLAW_CURSOR_COMMAND = command;
  if (apiKeyFile) env.OPENCLAW_CURSOR_API_KEY_FILE = apiKeyFile;
  const base = [WRAPPER, "-p", "--trust", ...(force ? ["--force"] : []), "--output-format", "stream-json"];

  const sdkExecute = createSdkExecute({
    apiKeyFile,
    useHttp1: pluginConfig.useHttp1 !== false,
    modelDefaults: pluginConfig.modelDefaults,
    finishOnFinalMessage: pluginConfig.finishOnFinalMessage !== false,
    ...(typeof pluginConfig.agentIdleMinutes === "number" ? { agentIdleMs: pluginConfig.agentIdleMinutes * 60 * 1000 } : {}),
    log,
  });
  const acpExecute = createAcpExecute({
    command,
    apiKeyFile,
    force,
    modelAliases: { ...ACP_MODEL_ALIASES, ...(pluginConfig.acpModelAliases ?? {}) },
    log,
  });

  const transportHooks = {
    // sdk (default): long-lived Cursor SDK agents; OpenClaw tools as customTools.
    // OpenClaw tools are filtered exactly; native tools are all-or-nothing (lib/tool-policy.js).
    sdk: {
      nativeToolMode: "selectable",
      toolAvailabilityEnforcement: "prepare-execution",
      projectNativeToolAuthority: projectCursorNativeToolAuthority,
      prepareExecution: async (pctx) => {
        const plan = planToolAvailability(pctx?.toolAvailability);
        if (!plan.enforceable) throw new Error(`cursor-cli cannot enforce this run's tool cap: ${plan.reason}`);
        return {
          execute: (ctx) => sdkExecute({
            ...ctx,
            thinkingLevel: pctx?.thinkingLevel,
            contextWindowOption: pctx?.contextWindow,
            openClawAllow: plan.openClawAllow,
          }),
          ...(pctx?.toolAvailability ? { toolAvailabilityEnforced: true } : {}),
        };
      },
    },
    // acp: one persistent `cursor-agent acp` process. Native tools cannot be capped.
    acp: {
      nativeToolMode: "always-on",
      prepareExecution: async (pctx) => ({
        execute: (ctx) => acpExecute({ ...ctx, thinkingLevel: pctx?.thinkingLevel }),
      }),
    },
    // print: one `cursor-agent -p` per turn, driven by OpenClaw's generic CLI runner.
    print: { nativeToolMode: "always-on" },
  }[transport];

  return {
    id: "cursor-cli",
    modelProvider: "cursor-cli",
    ...transportHooks,
    ...(transport !== "print"
      ? {
          ownsNativeCompaction: true,
          // The turn's OpenClaw loopback MCP grant, handed over as a Claude-style --mcp-config file.
          bundleMcp: true,
          bundleMcpMode: "claude-config-file",
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
      // cursor-agent has no system-prompt flag; print mode prepends this file, the other transports prepend ctx.systemPrompt.
      systemPromptFileArg: "--system-file",
      systemPromptWhen: "first",
      serialize: true,
      // Like claude-cli: after a session reset (e.g. MCP/tool fingerprint change), reseed the
      // new Cursor agent from the bounded raw OpenClaw transcript so prior context survives.
      reseedFromRawTranscriptWhenUncompacted: true,
      ...(transport !== "print" ? { imageArg: IMAGE_ARG, imageMode: "repeat", imagePathScope: "temp" } : {}),
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
  name: "Cursor Runtime",
  description: "Run Cursor agents as an OpenClaw CLI model backend",
  register(api) {
    const log = (m) => { try { (api.logger?.info ?? console.error)(m); } catch {} };
    api.registerCliBackend(buildCursorCliBackend(api.pluginConfig ?? {}, log));
  },
};
