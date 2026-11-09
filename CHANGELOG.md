# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) (0.x: minor versions may break).

## [0.4.0] - 2026-11-09

### Changed
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
