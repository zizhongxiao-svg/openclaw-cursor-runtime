# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (0.x: minor versions may break).

## [0.4.8] - 2026-11-10

### Changed
- Automatic compaction follows Claude Code: it runs only when one model call
  fills `autoCompactPercent` of the context window (default 90%, 270K of the
  300K default; 900K with the 1M window). 0.4.7 compacted from 80K tokens, which
  drops conversation detail and prompt-cache hits for every compaction.
  `autoCompactTokens` is now an optional absolute threshold that overrides the
  percentage. `/compact` is unchanged.

## [0.4.7] - 2026-11-10

### Added
- Compaction for Cursor sessions, modelled on `claude-cli`. The backend declares
  OpenClaw's `manualCompaction`, so `/compact [instructions]` asks the Cursor
  agent for a continuation summary, opens a fresh agent, and reports Claude
  Code's `compact_boundary` event. The successor's first turn receives the system
  prompt and the summary. Turns that still carry the old session id are routed to
  the successor; a turn arriving during a compaction waits for it.
- Automatic background compaction once one model call carries more than
  `autoCompactTokens` context tokens (default 80000 in this release, `0` turns
  it off; 0.4.8 switched to a share of the window). In
  production the WeChat agent reached ~107K tokens per call and Cursor's first
  response took 15–25 s, against 6–7 s for a fresh agent; Cursor's own
  summarisation only starts near the 300K window.
- Warm restarts: recent agents, compaction aliases/seeds and OpenClaw tool
  definitions persist in `~/.cache/openclaw-cursor-runtime/state.json` (mode
  0600, no credentials; `persistState`, `stateFile`). After start-up the plugin
  reopens recent agents (`prewarm`, `prewarmDelaySeconds`, default 180 s, once per
  process), and the first turn uses the saved tool list while refreshing it.
- The `cursor-cli: timing` line reports the turn's per-call context as `ctx=`.

## [0.4.6] - 2026-11-10

### Fixed
- The Cursor agent, OpenClaw tool list and SDK caches are shared across
  duplicate loads of the plugin. OpenClaw can register the plugin more than once
  in one gateway, and each load had its own caches: a turn served by the other
  load re-imported the SDK, re-opened the Cursor agent and re-listed tools
  (`sdk=701 tools=999 agent=3934` right after a warm turn). Setting
  `agentIdleMinutes` also gave every backend build a private agent cache; it now
  tunes the shared one.
- The "cannot enforce this run's tool cap" error names the fix for tool-capped
  background runs (route them to another backend, e.g. memory-core
  `dreaming.model`).

### Added
- The per-turn `cursor-cli: timing` line ends with `inst=<load>/t<thread>`, so
  duplicate plugin loads are visible in the gateway log.

## [0.4.5] - 2026-11-09

### Changed
- OpenClaw tool definitions are cached per workspace and allowed-tool set. In
  production, listing about 50 tools from the loopback server took 6–12 s per
  turn (`cursor-cli: timing … tools=12348(48)`). Later turns now start Cursor
  with the cached list and refresh it in the background using the current
  turn's grant. Calls always use the current turn's grant, so OpenClaw still
  enforces permissions. `toolListCache: false` (code option) disables the cache.

## [0.4.4] - 2026-11-09

### Fixed
- Sessions no longer wait for each other. With `serialize: true`, OpenClaw puts
  every run of a non-`claude-cli` backend behind one queue key, so a WeChat turn
  waited for a Telegram turn to finish. Each session has its own Cursor agent,
  and OpenClaw already orders turns within a session, so the backend now sets
  `serialize: false`.

### Added
- A per-turn timing log line: `cursor-cli: timing agent=… sdk= tools=(n) agent=
  first= lastTool= total= calls=`. It shows where a slow turn spent its time:
  the OpenClaw tool list, opening the agent, or waiting for Cursor's first
  event.

## [0.4.3] - 2026-11-09

### Added
- `finishOnFinalMessage` (default `true`). When the agent delivers its answer
  with `message(action: "send", final: true)`, the turn ends at once with
  `NO_REPLY` and the remaining Cursor run (the wrap-up model call) is
  cancelled. Measured on warm turns: 8.1–9.1 s → 5.4–5.7 s per turn. The reply
  reaches the chat at the same moment as before, but the session's queue moves
  on about 3 s sooner.

## [0.4.2] - 2026-11-09

### Removed
- The effort-suffixed catalog rows (`claude-opus-5-5-low` … `-max`). The model
  list shows a single `cursor-cli/claude-opus-5-5`, which declares them as
  replaced. Suffixed refs are still accepted at runtime.

## [0.4.1] - 2026-11-09

### Changed
- `/think` now lists exactly the efforts Cursor supports for Opus 5.5 (`low`,
  `medium`, `high`, `xhigh`, `max`). The catalog hides `off` and `minimal`,
  which Cursor does not have.

## [0.4.0] - 2026-11-09

### Changed
- The recommended model ref is `cursor-cli/claude-opus-5-5`, with no effort
  suffix: `/think` decides the Cursor effort (default `medium`, or
  `modelDefaults.effort`). The catalog row declares the `xhigh` and `max`
  thinking levels. `ultra` maps to `max`. Suffixed refs
  (`claude-opus-5-5-high`, …) still work and are marked deprecated in the
  catalog.
- Each turn logs the model and effort actually sent to Cursor
  (`cursor-cli: turn agent=… claude-opus-5-5 context=300k effort=high think=high`).
- Renamed the package and repository to `openclaw-cursor-runtime`, published
  at https://github.com/zizhongxiao-svg/openclaw-cursor-runtime. The OpenClaw plugin
  and backend id stays `cursor-cli`, so existing `cursor-cli/<model>` refs keep
  working.
- Side questions no longer declare `sideQuestionToolMode: "disabled"`. Cursor
  cannot run with zero native tools, so capped side questions now fail closed.
- Native tools are classified by the names `@cursor/sdk` reports in `tool_call`
  events (`shell`, `read`, `grep`, `edit`, …). Unclassified native tools are
  logged, and capped runs are refused once one has been seen.
- In the ACP transport, permission prompts are answered with `allow_once`
  instead of `allow_always`.
- `cursor-agent` child processes receive an allow-listed environment.
- `NO_REPLY` text is collapsed only after a successful messaging tool call.
- Requires Node.js 24.16 or newer, matching OpenClaw.

### Fixed
- Aborting a turn, or a consumer stopping early, now cancels the Cursor run.
  Before, native tools could keep running after the turn ended.
- ACP: multibyte UTF-8 text split across stdout chunks was corrupted.
- ACP: a cancel that `cursor-agent` ignored could hang the turn forever.
- The print wrapper reported success when `cursor-agent` died from a signal.
- Auth errors thrown by `send` or the stream, not only error results, are
  retried once.
- A failed `@cursor/sdk` import is retried on the next turn instead of being
  cached.

### Added
- Idle sweep for cached SDK agents (`agentIdleMinutes`, default 6 h), a cache
  keyed by agent id and working directory, and close-on-exit.
- MCP relay hardening: constant-time secret check, request size limit,
  upstream timeout, route deletion.
- A warning when the API key file is readable by group or others.
- Offline tests with a fake SDK (retry, abort, early stop, tool filtering,
  `NO_REPLY`), CI, security policy and contribution guide.

## [0.3.x] - 2026-11-09

- `sdk` transport (default): long-lived `@cursor/sdk` agents with OpenClaw tools
  as SDK `customTools`, model catalog with 300K/1M context windows, `/think` to
  effort, image input, per-call context sample, cached-token accounting,
  transcript reseed after session resets, tool-cap enforcement, retry once after
  an auth failure.

## [0.2.x] - 2026-11-09

- `acp` transport: one persistent `cursor-agent acp` process.

## [0.1.0] - 2026-11-09

- `print` transport: `cursor-agent -p` per turn.
