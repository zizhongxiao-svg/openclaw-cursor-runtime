#!/usr/bin/env node
// Adapter between OpenClaw's CLI-backend contract and cursor-agent:
//  - strips `--system-file <path>` and prepends that file to the prompt (cursor-agent has no system-prompt flag)
//  - reads the prompt from stdin and feeds it to cursor-agent on stdin (no argv length limit)
//  - loads CURSOR_API_KEY from OPENCLAW_CURSOR_API_KEY_FILE when the env var is unset
import { readFileSync } from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const args = [];
let systemFile;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--system-file") { systemFile = argv[++i]; continue; }
  if (a.startsWith("--system-file=")) { systemFile = a.slice(14); continue; }
  args.push(a);
}

const env = { ...process.env };
if (!env.CURSOR_API_KEY && env.OPENCLAW_CURSOR_API_KEY_FILE) {
  const file = env.OPENCLAW_CURSOR_API_KEY_FILE.replace(/^~(?=\/)/, os.homedir());
  try { env.CURSOR_API_KEY = readFileSync(file, "utf8").trim(); }
  catch (err) { process.stderr.write(`cursor-cli: cannot read API key file ${file}: ${err.message}\n`); process.exit(2); }
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let prompt = Buffer.concat(chunks).toString("utf8");
if (systemFile) {
  const sys = readFileSync(systemFile, "utf8").trim();
  if (sys) prompt = `<system_instructions>\n${sys}\n</system_instructions>\n\n${prompt}`;
}

const child = spawn(env.OPENCLAW_CURSOR_COMMAND || "cursor-agent", args, { env, stdio: ["pipe", "inherit", "inherit"] });
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("error", (err) => { process.stderr.write(`cursor-cli: failed to start cursor-agent: ${err.message}\n`); process.exit(127); });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
child.stdin.on("error", () => {});
child.stdin.end(prompt);
