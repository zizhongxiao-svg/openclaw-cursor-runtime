// Live check of /compact: facts from before compaction survive on the successor agent.
// Usage: node test/live/compact-smoke.mjs <apiKeyFile>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSdkExecute, AgentCache } from "../../lib/sdk-runtime.js";
import { SessionState } from "../../lib/session-state.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccli-compact-"));
const state = new SessionState({ file: path.join(tmp, "state.json") });
const exec = createSdkExecute({ apiKeyFile: process.argv[2], cache: new AgentCache(), state, log: (m) => console.log("LOG", m) });

async function turn(label, prompt, sessionId) {
  const t = Date.now();
  let sid; let result; const events = [];
  for await (const r of exec({ cwd: tmp, env: {}, args: [], prompt, modelId: "claude-opus-5-5-medium", systemPrompt: "You are 小满. Start every reply with '小满：'.", sessionId, useResume: Boolean(sessionId), timeoutMs: 180000 })) {
    if (r.type === "system") { events.push(r.subtype); sid = r.session_id; }
    if (r.type === "result") { result = r; sid = r.session_id; }
  }
  console.log(`${label} ${Date.now() - t}ms session=${sid} events=${events.join(",")} compact=${result?.compact_result ?? "-"} -> ${JSON.stringify(result?.result).slice(0, 140)}`);
  return sid;
}

const s1 = await turn("T1", "Remember: the code word is plum-37 and the release target is v0.4.7 on Friday. Reply: noted.");
await turn("T2", "Also remember the reviewer is Lin. Reply: noted.", s1);
const s2 = await turn("COMPACT", "/compact keep the code word, release target and reviewer", s1);
console.log("alias", s1, "->", state.resolve(s1), "seed chars", state.seed(s2)?.length ?? 0);
// OpenClaw might still send the old id: it must land on the successor.
await turn("T3", "What are the code word, the release target and the reviewer? One line.", s1);
console.log("seed after T3:", state.seed(s2) === undefined ? "cleared" : "still set");
process.exit(0);
