// Small persistent state for the SDK transport, kept across gateway restarts.
//
//   agents  - recently used Cursor agents (id -> cwd, model, last use), for startup prewarm
//   aliases - compacted agent id -> its successor, so a turn for the old id lands on the
//             new agent even before OpenClaw has stored the new session id
//   seeds   - continuation summary for a successor agent, sent with its first turn
//   tools   - OpenClaw tool definitions per tool-list cache key (names, descriptions and
//             schemas only; credentials are never stored)
//
// Without a file (tests, `persistState: false`) the state lives in memory only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Default state file; OPENCLAW_CURSOR_STATE_FILE overrides it (tests point it at a temp dir). */
export function defaultStateFile(env = process.env) {
  return env.OPENCLAW_CURSOR_STATE_FILE || path.join(os.homedir(), ".cache", "openclaw-cursor-runtime", "state.json");
}

const MAX_AGENTS = 32;
const MAX_TOOL_KEYS = 32;
const ALIAS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function empty() {
  return { version: 1, agents: {}, aliases: {}, seeds: {}, tools: {} };
}

export class SessionState {
  constructor({ file, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.data = empty();
    this.timer = undefined;
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (d && d.version === 1) this.data = { ...empty(), ...d };
    } catch {}
  }

  /** Debounced write (state changes come in bursts at the end of a turn). */
  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 1000);
    this.timer.unref?.();
  }

  flush() {
    if (!this.file) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  noteAgent(agentId, cwd, model) {
    if (!agentId) return;
    this.data.agents[agentId] = { cwd, model, lastUsed: this.now() };
    const ids = Object.keys(this.data.agents);
    if (ids.length > MAX_AGENTS) {
      ids.sort((a, b) => this.data.agents[a].lastUsed - this.data.agents[b].lastUsed);
      for (const id of ids.slice(0, ids.length - MAX_AGENTS)) delete this.data.agents[id];
    }
    this.save();
  }

  forgetAgent(agentId) {
    if (this.data.agents[agentId]) { delete this.data.agents[agentId]; this.save(); }
  }

  /** Agents used within maxAgeMs, most recent first. */
  recentAgents(maxAgeMs, limit = 8) {
    const cutoff = this.now() - maxAgeMs;
    return Object.entries(this.data.agents)
      .filter(([id, a]) => a.lastUsed >= cutoff && !this.data.aliases[id])
      .sort((a, b) => b[1].lastUsed - a[1].lastUsed)
      .slice(0, limit)
      .map(([id, a]) => ({ agentId: id, ...a }));
  }

  /** Follow compaction aliases to the current agent id. */
  resolve(agentId) {
    let id = agentId;
    const seen = new Set();
    while (id && this.data.aliases[id] && !seen.has(id)) {
      seen.add(id);
      id = this.data.aliases[id].to;
    }
    return id;
  }

  setAlias(from, to) {
    this.data.aliases[from] = { to, at: this.now() };
    const cutoff = this.now() - ALIAS_MAX_AGE_MS;
    for (const [k, v] of Object.entries(this.data.aliases)) if (v.at < cutoff) delete this.data.aliases[k];
    this.forgetAgent(from);
    this.save();
  }

  setSeed(agentId, summary) {
    this.data.seeds[agentId] = { summary, at: this.now() };
    this.save();
  }

  seed(agentId) {
    return this.data.seeds[agentId]?.summary;
  }

  clearSeed(agentId) {
    if (this.data.seeds[agentId]) { delete this.data.seeds[agentId]; this.save(); }
  }

  tools(key) {
    return this.data.tools[key]?.tools;
  }

  allTools() {
    return Object.entries(this.data.tools).map(([key, v]) => [key, v.tools]);
  }

  setTools(key, tools) {
    const prev = this.data.tools[key];
    if (prev && JSON.stringify(prev.tools) === JSON.stringify(tools)) { prev.at = this.now(); return; }
    this.data.tools[key] = { tools, at: this.now() };
    const keys = Object.keys(this.data.tools);
    if (keys.length > MAX_TOOL_KEYS) {
      keys.sort((a, b) => this.data.tools[a].at - this.data.tools[b].at);
      for (const k of keys.slice(0, keys.length - MAX_TOOL_KEYS)) delete this.data.tools[k];
    }
    this.save();
  }
}

/** Prompt asking the outgoing agent for a summary its successor can continue from. */
export function buildCompactionPrompt(customInstructions) {
  const extra = customInstructions?.trim() ? `\n\nAdditional instructions from the user: ${customInstructions.trim()}` : "";
  return `This conversation is being moved to a fresh agent because its context has grown large. Do not use any tools and do not send any messages. Reply only with a continuation summary that the next agent will receive in place of this conversation. Write it in the conversation's language and keep it under about 1500 words. Include:
1. Who the user is and their standing preferences or rules stated in this conversation.
2. The user's current goals and open requests, and what is still pending.
3. Key decisions, facts, results and numbers established so far.
4. Exact file paths, URLs, ids, commands and names that later turns may need.
5. The last few exchanges in enough detail to answer a follow-up naturally.
Leave out pleasantries, tool output that no longer matters, and anything already resolved and irrelevant.${extra}`;
}

/** First-turn text for a successor agent: the summary, then the new message. */
export function wrapWithSeed(summary, prompt) {
  return `<conversation_summary>\nThe earlier part of this conversation was compacted into this summary. Continue from it as if you had the whole conversation.\n\n${summary}\n</conversation_summary>\n\n${prompt ?? ""}`;
}
