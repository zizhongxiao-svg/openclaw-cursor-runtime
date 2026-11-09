#!/usr/bin/env node
// Print-transport adapter between OpenClaw's CLI-backend contract and cursor-agent:
//  - strips `--system-file <path>` and prepends that file to the prompt (cursor-agent has no system-prompt flag)
//  - reads the prompt from stdin and feeds it to cursor-agent on stdin (no argv length limit)
//  - loads CURSOR_API_KEY from OPENCLAW_CURSOR_API_KEY_FILE when the env var is unset
//  - passes cursor-agent only an allow-listed environment
import { readFileSync } from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { childEnv, readApiKey } from "../lib/common.js";

const argv = process.argv.slice(2);
const args = [];
let systemFile;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--system-file") { systemFile = argv[++i]; continue; }
  if (a.startsWith("--system-file=")) { systemFile = a.slice(14); continue; }
  args.push(a);
}

const env = childEnv(process.env);
try {
  const key = readApiKey(process.env, process.env.OPENCLAW_CURSOR_API_KEY_FILE, (m) => process.stderr.write(`${m}\n`));
  if (key) env.CURSOR_API_KEY = key;
} catch (err) {
  process.stderr.write(`cursor-cli: cannot read API key file: ${err.message}\n`);
  process.exit(2);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let prompt = Buffer.concat(chunks).toString("utf8");
if (systemFile) {
  const sys = readFileSync(systemFile, "utf8").trim();
  if (sys) prompt = `<system_instructions>\n${sys}\n</system_instructions>\n\n${prompt}`;
}

const child = spawn(process.env.OPENCLAW_CURSOR_COMMAND || "cursor-agent", args, { env, stdio: ["pipe", "inherit", "inherit"] });
const forwarded = ["SIGTERM", "SIGINT", "SIGHUP"];
for (const sig of forwarded) process.on(sig, () => child.kill(sig));
child.on("error", (err) => { process.stderr.write(`cursor-cli: failed to start cursor-agent: ${err.message}\n`); process.exit(127); });
child.on("exit", (code, signal) => {
  // Re-raising the signal would hit our own forwarding handlers; report it as 128+n instead.
  if (signal) process.exit(128 + (os.constants.signals[signal] ?? 1));
  process.exit(code ?? 1);
});
child.stdin.on("error", () => {});
child.stdin.end(prompt);
