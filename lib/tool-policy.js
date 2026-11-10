// Native tool vocabulary and OpenClaw tool-cap enforcement for the Cursor SDK transport.
//
// OpenClaw refuses to start a CLI run that carries a tool cap (automations, cron
// jobs, restricted senders, workspace-only policies) unless the backend can enforce
// it. Cursor's SDK cannot switch individual native tools off, so the policy is
// deliberately conservative:
//   - OpenClaw tools are filtered exactly (only the allowed customTools are registered);
//   - native tools run in full agent mode only when every capability they grant is
//     allowed; any narrower native cap is reported as not enforceable, so OpenClaw
//     fails closed instead of the run exceeding its cap;
//   - native tool names the plugin has not classified are tracked as they are observed,
//     and once one is seen no capped run is accepted until the map below covers it.

/**
 * Native tools by the names @cursor/sdk reports in `tool_call` events, mapped to the
 * canonical OpenClaw capability each grants (undefined: grants none on its own).
 */
export const CURSOR_NATIVE_TOOLS = Object.freeze({
  read: "read",
  grep: "read", // returns file content
  glob: undefined, // locates paths only
  ls: undefined,
  edit: "edit",
  write: "write",
  delete: "write",
  shell: "exec",
  web_search: "web_search",
  web_fetch: "web_fetch",
  todo_write: undefined,
  task: undefined, // sub-agent with the same tool surface
});

export const CURSOR_NATIVE_TOOL_NAMES = Object.freeze(Object.keys(CURSOR_NATIVE_TOOLS));

/** tool_call names that are not native tools (the bridge to OpenClaw customTools). */
const BRIDGE_TOOL_NAMES = new Set(["mcp"]);

/** Canonical capabilities agent mode grants as a whole. */
const AGENT_MODE_CAPABILITIES = Object.freeze([...new Set(Object.values(CURSOR_NATIVE_TOOLS).filter(Boolean))]);

// Shared across duplicate loads of this module (see SHARED_KEY in sdk-runtime.js).
const unknownObserved = (globalThis[Symbol.for("openclaw-cursor-runtime.unknownNativeTools")] ??= new Set());

/**
 * Record a tool_call name seen in a run. Returns true the first time an
 * unclassified native tool is seen (callers log it).
 */
export function observeNativeTool(name) {
  if (!name || BRIDGE_TOOL_NAMES.has(name) || Object.hasOwn(CURSOR_NATIVE_TOOLS, name)) return false;
  if (unknownObserved.has(name)) return false;
  unknownObserved.add(name);
  return true;
}

export function unknownNativeTools() {
  return [...unknownObserved];
}

export function resetObservedNativeToolsForTest() {
  unknownObserved.clear();
}

/**
 * projectNativeToolAuthority hook: map reported native tools to the canonical
 * OpenClaw capabilities they grant (used for automation creator caps). Unknown names
 * grant nothing.
 */
export function projectCursorNativeToolAuthority(nativeTools) {
  const out = new Set();
  for (const name of nativeTools ?? []) {
    const cap = Object.hasOwn(CURSOR_NATIVE_TOOLS, name) ? CURSOR_NATIVE_TOOLS[name] : undefined;
    if (cap) out.add(cap);
  }
  return [...out];
}

/**
 * Decide whether a run's tool availability can be honoured.
 * @returns {{ enforceable: boolean, openClawAllow?: Set<string>, reason?: string }}
 */
export function planToolAvailability(toolAvailability, unknown = unknownNativeTools()) {
  if (!toolAvailability) return { enforceable: true };
  const openClawAllow = new Set(toolAvailability.openClaw ?? []);
  if (unknown.length) {
    return { enforceable: false, openClawAllow, reason: `Cursor exposed native tools this plugin does not classify: ${unknown.join(", ")}` };
  }
  const allowedCaps = new Set(projectCursorNativeToolAuthority(toolAvailability.native));
  const missing = AGENT_MODE_CAPABILITIES.filter((cap) => !allowedCaps.has(cap));
  if (missing.length) {
    return { enforceable: false, openClawAllow, reason: `Cursor cannot disable native tools granting: ${missing.join(", ")}` };
  }
  return { enforceable: true, openClawAllow };
}
