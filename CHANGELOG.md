# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (0.x: minor versions may break).

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
