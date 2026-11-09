// Native tool vocabulary and OpenClaw tool-cap enforcement for the Cursor SDK transport.
//
// OpenClaw refuses to start a CLI run that carries a tool cap (automations, cron
// jobs, restricted senders, workspace-only policies) unless the backend can
// enforce it. Cursor's SDK cannot switch individual native tools off, so the
// policy is deliberately conservative:
//   - OpenClaw tools are filtered exactly (only the allowed customTools are registered);
//   - native tools run in full "agent" mode only when every capability they grant is
//     allowed; any narrower native cap is reported as not enforceable, so OpenClaw
//     fails closed instead of the run exceeding its cap.

/** Cursor agent-mode native tools and the canonical OpenClaw capability each one grants. */
export const CURSOR_NATIVE_TOOLS = Object.freeze({
  Read: "read",
  Glob: undefined, // locates paths only
  Grep: "read", // returns file content
  Write: "write",
  Delete: "write",
  StrReplace: "edit",
  EditNotebook: "edit",
  Shell: "exec",
  AwaitShell: "exec",
  WebSearch: "web_search",
  WebFetch: "web_fetch",
  Task: undefined, // sub-agent with the same tool surface
  TodoWrite: undefined,
  AskQuestion: undefined,
  GenerateImage: undefined,
});

export const CURSOR_NATIVE_TOOL_NAMES = Object.freeze(Object.keys(CURSOR_NATIVE_TOOLS));

/** Canonical capabilities agent mode grants as a whole. */
const AGENT_MODE_CAPABILITIES = Object.freeze([...new Set(Object.values(CURSOR_NATIVE_TOOLS).filter(Boolean))]);

/**
 * projectNativeToolAuthority hook: map the native tools a turn reported to the
 * canonical OpenClaw capabilities they grant (used for automation creator caps).
 */
export function projectCursorNativeToolAuthority(nativeTools) {
  const out = new Set();
  for (const name of nativeTools ?? []) {
    const cap = CURSOR_NATIVE_TOOLS[name];
    if (cap) out.add(cap);
  }
  return [...out];
}

/**
 * Decide how to honour a run's tool availability.
 * @returns {{ enforceable: boolean, openClawAllow?: Set<string>, reason?: string }}
 */
export function planToolAvailability(toolAvailability) {
  if (!toolAvailability) return { enforceable: true };
  const openClawAllow = new Set(toolAvailability.openClaw ?? []);
  const allowedCaps = new Set(projectCursorNativeToolAuthority(toolAvailability.native));
  const missing = AGENT_MODE_CAPABILITIES.filter((cap) => !allowedCaps.has(cap));
  if (missing.length) {
    return { enforceable: false, openClawAllow, reason: `Cursor cannot disable native tools granting: ${missing.join(", ")}` };
  }
  return { enforceable: true, openClawAllow };
}
