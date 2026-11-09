// Helpers shared by the transports.
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** argv flag OpenClaw uses to hand image paths to the backend (config.imageArg). */
export const IMAGE_ARG = "--openclaw-image";
export const IMAGE_MIME = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
});

/** Effort suffixes accepted on OpenClaw model ids, e.g. claude-opus-5-5-high. */
export const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
/** OpenClaw thinking level -> Cursor effort value. */
export const THINKING_TO_EFFORT = Object.freeze({
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  adaptive: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
});

export function expandHome(p) {
  if (p === "~") return os.homedir();
  return String(p).replace(/^~(?=\/)/u, os.homedir());
}

const warnedKeyFiles = new Set();

/** CURSOR_API_KEY from the environment, else the trimmed contents of apiKeyFile. */
export function readApiKey(env, apiKeyFile, log) {
  if (env?.CURSOR_API_KEY) return env.CURSOR_API_KEY;
  if (!apiKeyFile) return undefined;
  const file = expandHome(apiKeyFile);
  try {
    const st = statSync(file);
    if (process.platform !== "win32" && (st.mode & 0o077) && !warnedKeyFiles.has(file)) {
      warnedKeyFiles.add(file);
      log?.(`cursor-cli: API key file ${file} is readable by group or others; run chmod 600 on it`);
    }
  } catch {}
  return readFileSync(file, "utf8").trim();
}

/** First turn of a new Cursor agent carries OpenClaw's system prompt inline (Cursor has no system-prompt input). */
export function buildPromptText({ systemPrompt, prompt, promptContext, isNew }) {
  const parts = [];
  if (isNew && systemPrompt) parts.push(`<system_instructions>\n${systemPrompt}\n</system_instructions>`);
  if (promptContext?.prependContext) parts.push(promptContext.prependContext);
  parts.push(prompt ?? "");
  if (promptContext?.appendContext) parts.push(promptContext.appendContext);
  return parts.join("\n\n");
}

export function extractImagePaths(args) {
  const out = [];
  for (let i = 0; i < (args?.length ?? 0); i += 1) {
    if (args[i] === IMAGE_ARG && args[i + 1]) out.push(args[++i]);
  }
  return out;
}

/** Read image files as base64 payloads; unreadable files are skipped and logged. */
export function readImages(paths, log) {
  const out = [];
  for (const p of paths) {
    try {
      out.push({ data: readFileSync(p).toString("base64"), mimeType: IMAGE_MIME[path.extname(p).toLowerCase()] ?? "image/png" });
    } catch (err) {
      log?.(`cursor-cli: cannot read image ${p}: ${err.message}`);
    }
  }
  return out;
}

// Environment passed to cursor-agent child processes (acp/print transports). The
// gateway environment can hold unrelated secrets; cursor-agent and the shell tools it
// runs only need the basics, proxy/CA settings and Cursor's own variables.
const CHILD_ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|TMP|TEMP|TERM|COLORTERM|DISPLAY|XDG_[A-Z_]+|HTTPS?_PROXY|https?_proxy|ALL_PROXY|all_proxy|NO_PROXY|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|NODE_USE_ENV_PROXY|NODE_OPTIONS|CURSOR_[A-Z0-9_]+|OPENCLAW_CURSOR_[A-Z0-9_]+)$/u;

export function childEnv(...sources) {
  const merged = Object.assign({}, ...sources);
  const out = {};
  for (const [k, v] of Object.entries(merged)) if (v !== undefined && CHILD_ENV_ALLOW.test(k)) out[k] = String(v);
  return out;
}
