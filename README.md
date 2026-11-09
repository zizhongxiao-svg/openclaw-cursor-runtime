# openclaw-cursor-cli

Run [Cursor](https://cursor.com) agents as a model runtime in [OpenClaw](https://github.com/openclaw/openclaw),
the same way OpenClaw runs Claude Code through its bundled `claude-cli` backend.

The plugin registers a CLI backend with id `cursor-cli`. Point an agent at a
`cursor-cli/<model>` ref and its turns run on a long-lived local Cursor agent
that has OpenClaw's own tools (messaging, automations, sub-agents, browser,
files, …) next to Cursor's native tools (shell, read/write, web search).

## Features

- **Same backend type as `claude-cli`.** OpenClaw prepares the turn (system
  prompt, workspace bootstrap, tool grant, session binding, fallbacks) and the
  plugin runs it. Fallback models keep working when Cursor fails a turn.
- **OpenClaw tools with the same authority as `claude-cli`.** Each turn's tools
  come from OpenClaw's per-turn loopback MCP grant (`bundleMcp`,
  `claude-config-file`) and are registered as Cursor SDK `customTools`. Calls are
  forwarded with that turn's credentials. This also works when a Cursor team
  policy blocks MCP servers.
- **Long-lived sessions.** One Cursor agent per OpenClaw session, kept in memory
  while the gateway runs and reopened with `Agent.resume` after a restart. A
  session reset reseeds the new agent from the OpenClaw transcript.
- **`/think` → Cursor effort** (`low`, `medium`, `high`, `xhigh`, `max`).
- **Images** sent by the user are passed to the model.
- **Streaming text**, token usage (cached tokens are not double counted, and a
  per-call context sample is reported), `NO_REPLY` normalisation, side
  questions (`/btw`) in a separate read-only agent.
- **Model catalog** for `cursor-cli/claude-opus-5-5-*` with a 300K default
  context window (1M selectable), so `/status` knows the window; the selected
  window is passed to Cursor as the `context` parameter.
- **Tool caps** for automations and restricted runs (see limitations).

## Requirements

- OpenClaw 2026.10 or newer, running on Node 24.
- A Cursor API key (`CURSOR_API_KEY`, or a file referenced by `apiKeyFile`).
- Network access from the gateway to Cursor. Behind an HTTP proxy, start the
  gateway with a proxy-aware fetch (OpenClaw's proxy preload) and keep
  `useHttp1: true` (the default).
- `cursor-agent` on `PATH` only for the `acp` and `print` transports.

## Install

```bash
git clone <this repo> ~/openclaw-cursor-cli
cd ~/openclaw-cursor-cli
npm install --omit=peer --legacy-peer-deps
openclaw plugins install --link ~/openclaw-cursor-cli
```

Install or reinstall while the gateway is stopped: a live plugin replacement
can leave in-flight turns retired.

## Configure

```json5
{
  plugins: {
    entries: {
      "cursor-cli": {
        enabled: true,
        config: {
          apiKeyFile: "~/.config/cursor/api-key",   // or set CURSOR_API_KEY
          // transport: "sdk",                      // default; "acp" | "print"
          // useHttp1: true,
          // modelDefaults: { context: "300k" },    // "1m" for the 1M window
        },
      },
    },
  },
  agents: {
    defaults: {
      models: {
        "cursor-cli/claude-opus-5-5-medium": { alias: "cursor", params: { thinking: "medium" } },
      },
      modelPolicy: { allow: ["cursor-cli/claude-opus-5-5-medium" /* , … */] },
    },
    entries: {
      "my-agent": { model: { primary: "cursor-cli/claude-opus-5-5-medium" } },
    },
  },
}
```

Model refs are `cursor-cli/<cursor model id>[-<effort>]`, for example
`cursor-cli/claude-opus-5-5-high`, `cursor-cli/gpt-5.6-sol-medium`,
`cursor-cli/composer-2.5` or `cursor-cli/auto`. A trailing effort becomes the
Cursor `effort` parameter; Claude models also get `context=300k` (configurable)
and `fast=false`.

Set `params.thinking` on the model entry when the global `thinkingDefault`
differs from the effort you want by default; `/think` overrides it per session.

## Transports

| `transport` | How turns run | OpenClaw tools | Typical warm turn |
| --- | --- | --- | --- |
| `sdk` (default) | Long-lived `@cursor/sdk` local agents | yes | ~5 s + tool overhead |
| `acp` | One persistent `cursor-agent acp` process | no (Cursor ignores ACP session MCP servers) | ~3 s |
| `print` | One `cursor-agent -p` process per turn | no | ~9 s |

## Known limitations

- Cursor reports one usage total per run. The per-call context sample divides
  it by the number of model calls (tool calls + 1), so `/status` context is an
  estimate.
- Cursor's native tools are always on; OpenClaw exec approvals do not gate them
  (same as `claude-cli` in bypass mode). `force: false` routes ACP permission
  prompts to OpenClaw.
- Tool caps (automations, cron jobs, restricted senders, workspace-only
  policies): OpenClaw tools are filtered exactly, but Cursor cannot switch
  individual native tools off. A capped run is accepted only when every native
  capability (read, write, edit, exec, web_search, web_fetch) is allowed; a
  narrower native cap fails closed with "cursor-cli cannot enforce this run's
  tool cap". The native tool list is reported to OpenClaw, so automations
  created from a Cursor session record the full native capability set.
- Side questions (`/btw`) run in Cursor's read-only plan mode, which still
  allows read-only native tools.
- Explicit `/compact` is not supported; Cursor compacts its own context.

## Development

```bash
npm test                    # offline unit tests (node --test)
node test/live/sdk-smoke.mjs ~/.config/cursor/api-key   # live, needs a Cursor key
```

`test/live/` scripts talk to the real Cursor service and are not run by `npm test`.

## License

MIT
