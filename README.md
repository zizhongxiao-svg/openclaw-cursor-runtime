# openclaw-cursor-runtime

Run [Cursor](https://cursor.com) agents as a model runtime in
[OpenClaw](https://github.com/openclaw/openclaw), the same way OpenClaw runs
Claude Code through its bundled `claude-cli` backend.

The plugin registers a CLI backend with id `cursor-cli`. Point an agent at a
`cursor-cli/<model>` ref and its turns run on a long-lived local Cursor agent.
That agent has OpenClaw's own tools (messaging, automations, sub-agents,
browser, files and so on) next to Cursor's native tools (shell, read/edit,
search).

> Status: early (0.x). Developed and run against OpenClaw 2026.10.9 and
> `@cursor/sdk` 1.0.23 on Linux. Other versions and platforms are untested.

## Quick start

```bash
git clone https://github.com/zizhongxiao-svg/openclaw-cursor-runtime ~/openclaw-cursor-runtime
cd ~/openclaw-cursor-runtime && npm ci --omit=dev --legacy-peer-deps
openclaw plugins install --link --accept-capabilities ~/openclaw-cursor-runtime
echo "$CURSOR_API_KEY" > ~/.config/cursor/api-key && chmod 600 ~/.config/cursor/api-key
```

Then point the plugin at the key and give an agent a Cursor model (full example
in [Configure](#configure)):

```json5
plugins: { entries: { "cursor-cli": { enabled: true, config: { apiKeyFile: "~/.config/cursor/api-key" } } } },
agents: { entries: { "my-agent": { model: { primary: "cursor-cli/claude-opus-5-5" } } } },
```

Restart the gateway, then send the agent a message. `/status` should show
`Model: cursor-cli/claude-opus-5-5`.

The package is named `openclaw-cursor-runtime`. Inside OpenClaw the plugin and
backend id is `cursor-cli`, following the bundled `claude-cli` naming, so model
refs look like `cursor-cli/<model>`.

## Features

- **Same backend type as `claude-cli`.** OpenClaw prepares the turn (system
  prompt, workspace bootstrap, tool grant, session binding, fallbacks) and the
  plugin runs it. When a Cursor turn fails, OpenClaw's model fallback takes over.
- **OpenClaw tools, with `claude-cli`'s authority.** Each turn's tools come from
  OpenClaw's per-turn loopback MCP grant and are registered as Cursor SDK
  `customTools`. Calls are forwarded with that turn's credentials. This also
  works when a Cursor team policy blocks MCP servers.
- **Long-lived sessions.** One Cursor agent per OpenClaw session. A session reset
  reseeds the new agent from the OpenClaw transcript.
- **Tool caps.** Automations, cron jobs and restricted runs are enforced or
  refused (fail closed). See [Security model](#security-model).
- **`/think` maps to Cursor effort** (`low` … `max`). A model catalog gives
  `cursor-cli/claude-opus-5-5` a 300K default window (1M selectable).
- **Image input**, streaming text, and token usage. Cached tokens are not
  counted twice, and a per-call context sample feeds `/status`.
- **Recovery.** A Cursor auth failure before any work is retried once on a
  fresh connection. A cancelled turn stops the Cursor run.

## How it works

```
OpenClaw gateway ──turn──▶ cursor-cli backend (this plugin)
   │  prompt, session id, tool cap,          │
   │  --mcp-config (per-turn grant)          ▼
   │                                  @cursor/sdk local agent  ──▶ Cursor API
   │                                    │  native tools (shell, read, edit …)
   │◀── tools/call (turn grant) ────────┘  customTools = OpenClaw tools
   ▼
reply / NO_REPLY, usage, session id
```

1. OpenClaw calls the backend's `prepareExecution` with the run's tool
   availability, thinking level and context window. The plugin checks that it
   can enforce the tool cap, or throws.
2. `execute` opens or reuses the session's Cursor agent and lists the turn's
   OpenClaw tools from the loopback MCP server named in `--mcp-config`. It then
   sends the prompt and streams Cursor's events back as `claude-stream-json`
   records.
3. Tool calls to OpenClaw go through the same loopback server with that turn's
   Bearer token and capture key. Outside the turn the grant is no longer valid.

Three transports are available:

| `transport` | How turns run | OpenClaw tools | Tool caps |
| --- | --- | --- | --- |
| `sdk` (default) | long-lived `@cursor/sdk` local agents | yes | enforced (all-or-nothing for native tools) |
| `acp` | one persistent `cursor-agent acp` process | only if Cursor loads ACP session MCP servers | not enforced |
| `print` | one `cursor-agent -p` per turn | no | not enforced |

## Requirements

- OpenClaw 2026.10 or newer on Node.js 24.16 or newer. These are OpenClaw's own
  requirements.
- A Cursor API key: `CURSOR_API_KEY`, or a file named by `apiKeyFile`. Keep the
  file at mode `600`.
- Network access from the gateway to Cursor. Behind an HTTP proxy, the gateway
  process must route `fetch` through the proxy (for example with
  `NODE_USE_ENV_PROXY=1`). The default `useHttp1: true` avoids proxies that break
  HTTP/2. If requests leave from a region Cursor's model providers do not serve,
  runs fail with "model provider is not supported in your region".
- `cursor-agent` on `PATH`, for the `acp` and `print` transports only.

## Install

```bash
git clone https://github.com/zizhongxiao-svg/openclaw-cursor-runtime ~/openclaw-cursor-runtime
cd ~/openclaw-cursor-runtime
npm ci --omit=dev --legacy-peer-deps      # the openclaw peer comes from your gateway
openclaw plugins install --link --accept-capabilities ~/openclaw-cursor-runtime
```

Install and reinstall with the gateway running. Avoid `openclaw plugins reload`
while turns are in flight, because it can retire a running call. Restart the
gateway instead once it is idle.

## Configure

```json5
{
  plugins: {
    entries: {
      "cursor-cli": {
        enabled: true,
        config: {
          apiKeyFile: "~/.config/cursor/api-key",   // or set CURSOR_API_KEY
          // transport: "sdk",                      // "acp" | "print"
          // useHttp1: true,                        // process-wide, read once
          // modelDefaults: { context: "300k" },    // default context for claude-* models
          // agentIdleMinutes: 360,                 // close idle cached agents
        },
      },
    },
  },
  agents: {
    defaults: {
      models: {
        // params.thinking: default effort when the global thinkingDefault differs
        "cursor-cli/claude-opus-5-5": { alias: "cursor", params: { thinking: "medium" } },
      },
      modelPolicy: { allow: ["cursor-cli/claude-opus-5-5"] },
    },
    entries: {
      "my-agent": { model: { primary: "cursor-cli/claude-opus-5-5" } },
    },
  },
}
```

### Model refs and `/think`

Use `cursor-cli/claude-opus-5-5`. The effort comes from OpenClaw's thinking
level, so `/think high` in a chat switches the next turns to Cursor
`effort=high`, with no change of model.

`/think` offers exactly the efforts Cursor supports for Opus 5.5. The catalog
hides `off` and `minimal`, which Cursor does not have.

| `/think` | Cursor effort |
| --- | --- |
| default | `medium` (or `modelDefaults.effort`) |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` | `xhigh` (Extra High) |
| `max` | `max` |
| `ultra` (OpenClaw's delegation mode, always listed) | `max` |

To confirm, check two places:

- `/status`: the `Modes: think <level>` line shows the session's level.
- The gateway log: each turn logs a line such as
  `cursor-cli: turn agent=… claude-opus-5-5 context=300k effort=high think=high`.

`claude-*` models also get `context=300k` (`modelDefaults.context`, or the
catalog's context window option) and `fast=false`.

Refs with an effort suffix (`cursor-cli/claude-opus-5-5-high`) still work and
fix the default effort, but `/think` overrides them. The catalog marks them as
deprecated in favour of `cursor-cli/claude-opus-5-5`.

The bundled model catalog covers `claude-opus-5-5`. Other Cursor ids, such as
`gpt-5.6-sol`, `composer-2.5` or `auto`, are passed through and usually work.
They have no catalog entry, so `/status` shows their context window as `?`, and
they are less tested.

## Security model

Read this before enabling the plugin for untrusted senders.

- **Native tools run with the gateway user's full authority.** Cursor's shell
  and edit tools execute on the gateway host, and OpenClaw's exec approvals do
  not gate them. This matches `claude-cli` in bypass-permissions mode. Prompt
  injection, including through content returned by OpenClaw tools or web
  fetches, can reach `shell`.
- **Tool caps.** OpenClaw tools are filtered exactly to the run's allowed list.
  Cursor's SDK cannot switch individual native tools off, so a capped run is
  accepted only when the cap allows every native capability (read, write, edit,
  exec, web_search, web_fetch). Otherwise the run is refused with "cursor-cli
  cannot enforce this run's tool cap". If Cursor uses a native tool this plugin
  has not classified, it logs the tool and refuses all capped runs until
  `lib/tool-policy.js` covers it.
- **Side questions** (`/btw`) run in Cursor's read-only plan mode when
  uncapped. When a side question requires zero native tools, it is refused,
  because Cursor still offers read-only tools in plan mode.
- **Credentials.** The API key is read from the environment or the key file and
  passed only to the SDK or to `cursor-agent`. OpenClaw's per-turn MCP grant
  lives in memory for the turn. The `acp` and `print` transports give
  `cursor-agent` an allow-listed environment.
- **ACP relay.** The `acp` transport listens on `127.0.0.1` only, behind a random
  secret path. Requests outside an active turn get 503.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `Model not available … not supported in your region` | Gateway traffic to Cursor does not go through your proxy. Enable a proxy-aware fetch for the gateway (`NODE_USE_ENV_PROXY=1` or your preload). |
| `WritableIterable is closed` | An HTTP proxy breaking HTTP/2. Keep `useHttp1: true`. |
| `Authentication error … try logging out and back in` once after a long idle period | Cursor's cached access token expired. The plugin retries once automatically, and a second failure falls back to the next model. |
| `MCP server … blocked by team policy` (acp/print) | Your Cursor team blocks MCP servers. Use the default `sdk` transport, which needs no MCP. |
| `cursor-cli cannot enforce this run's tool cap` | The run's cap is narrower than Cursor can enforce, or Cursor used an unclassified native tool (see the gateway log). |
| `/status` shows `Context: …/?` | The model has no catalog entry (only `claude-opus-5-5` is catalogued). |
| Reply shows `NO_REPLY` text or an "empty reply" error | Update to ≥0.4. The plugin normalises `NO_REPLY` after a messaging tool call. |

## Development

```bash
npm test                                             # offline unit tests (node --test), no network
node test/live/sdk-smoke.mjs ~/.config/cursor/api-key   # live: needs a Cursor key and network
```

`test/live/` scripts talk to the real Cursor service. They are not run by
`npm test` or CI. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT for this plugin's code ([LICENSE](LICENSE)).

The plugin depends on `@cursor/sdk`, which is proprietary: © Anysphere Inc., all
rights reserved, use subject to Cursor's Terms of Service. npm installs it from
the npm registry. It is not part of this repository and is not covered by the
MIT license. Using this plugin requires a Cursor account and acceptance of
Cursor's terms.
