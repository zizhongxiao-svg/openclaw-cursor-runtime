# Security policy

## Supported versions

Security fixes go into the latest 0.x release.

## Reporting a vulnerability

Please do not open a public issue. Report it privately, either through GitHub's
"Report a vulnerability" (private security advisory) on this repository or by
e-mail to zizhong.xiao@gmail.com. Include the plugin version, the OpenClaw and
`@cursor/sdk` versions, and steps to reproduce. You should get a reply within a
week.

## Scope

These are in scope:

- A tool cap (automation, cron, restricted sender, workspace-only policy) that
  the plugin accepts but does not enforce.
- OpenClaw tool access outside an active turn, or with another turn's grant.
- Leaks of the Cursor API key or OpenClaw MCP grant headers, to logs, disk,
  child processes or other local users.
- Problems in the local MCP relay of the `acp` transport.

These are out of scope, because they are documented behaviour (see "Security
model" in the README):

- Native Cursor tools running with the gateway user's authority.
- Prompt injection through content the agent reads.
