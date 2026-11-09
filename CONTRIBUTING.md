# Contributing

Thanks for helping. This plugin sits between two fast-moving runtimes (OpenClaw
and Cursor), so small, well-tested changes are easiest to review.

## Setup

```bash
git clone https://github.com/zizhongxiao-svg/openclaw-cursor-runtime
cd openclaw-cursor-runtime
npm ci --legacy-peer-deps
npm test
```

Node.js 24.16 or newer is required.

## Tests

- `npm test` runs the offline suite (`test/*.test.mjs`) with `node --test`. It
  needs no network access, Cursor account or OpenClaw gateway. A fake
  `@cursor/sdk` (`fakeSdk` in `test/unit.test.mjs`) drives the execute
  generator. Add a case there for every behaviour change in `lib/`.
- `test/live/*.mjs` are manual scripts against the real Cursor service. They
  need an API key file passed as the first argument and, behind a proxy, a
  proxy-aware Node. Run the relevant one before you change a transport, and
  mention the result in the pull request.

## Guidelines

- Keep the OpenClaw CLI backend contract in mind: the records yielded by
  `execute` are parsed as `claude-stream-json`. Tool-cap enforcement must fail
  closed.
- Do not add dependencies without a strong reason.
- Native tools: when Cursor starts reporting a new `tool_call` name, classify
  it in `lib/tool-policy.js` (the capability it grants, or `undefined`) and add
  a test.
- Never log API keys, MCP grant headers or prompt contents.
- Update `CHANGELOG.md` under an "Unreleased" heading.

## Releases

1. Bump `version` in `package.json` and `openclaw.plugin.json`. A test checks
   that they match.
2. Move the "Unreleased" changelog entries under the new version.
3. Tag `vX.Y.Z` and publish.
