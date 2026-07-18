# mcp-proxy Improvements — Design

**Status:** Approved
**Date:** 2026-07-19

## Context

mcp-proxy is a single-file (`index.js`, ~150 lines), single-dependency stdio
proxy that consolidates multiple MCP servers behind one meta-tool per server,
working around MCP client tool-count limits. It has one commit, no tests, no
CI, and covers only the `tools` surface of the MCP spec.

The project is already published as open source. This document scopes a set
of improvements across four areas: reliability, MCP feature parity, open-source
hygiene, and agent-facing UX.

## Approach

Deliver in four independently shippable phases rather than one large rewrite.
Each phase is releasable on its own; the codebase is only split into modules
once a phase's changes actually make `index.js` too large to stay cohesive
(expected after Phase 1). This keeps risk low for a single-maintainer project
and avoids speculative structure (YAGNI).

Target end-state file layout (reached gradually, not up front):

```
mcp-proxy/
├── index.js              # thin entry point: load config, start server
├── src/
│   ├── config.js         # config loading + schema validation
│   ├── child-manager.js  # child MCP lifecycle: connect, reconnect, disconnect, health
│   ├── meta-tool.js      # meta-tool schema generation
│   ├── router.js         # tool_name/tool_input routing + timeout + error wrapping
│   └── logger.js         # structured stderr logging
├── test/
│   ├── fixtures/          # fake stdio MCP servers (normal, flaky, resource-capable)
│   ├── config.test.js
│   ├── meta-tool.test.js
│   └── router.test.js
├── .github/workflows/ci.yml
└── docs/plans/
```

Split point: after Phase 1 (reconnect/timeout/validation logic pushes
`index.js` past ~300 lines), extract `config.js` + `child-manager.js`. After
Phase 2, extract `router.js` + `meta-tool.js`.

## Phase 1 — Reliability

Goal: a crashed child or bad config should never leave the proxy silently
broken; the agent should see a clear, actionable error instead.

- **Config validation at startup.** Each `mcpServers` entry requires
  `command` (string) and, if present, `args` (array). Empty-string env values
  (e.g. `"REDIS_URL": ""`) log a warning but don't block startup — the child
  will surface its own error. A malformed top-level schema (e.g. missing
  `mcpServers`) exits with a clear message, no stack trace.
- **Per-server `disabled` flag.** `"disabled": true` skips that server at
  startup with a "skipped (disabled)" log line — lets a user toggle a heavy
  or broken child off without deleting its config block.
- **Connection timeout.** `connectChild()` gets a default 10s timeout
  (override: `connectTimeoutMs` per server). Currently a non-responsive child
  can hang startup indefinitely.
- **Crash → reconnect.** Listen to the child transport's close/error
  events. On unexpected exit: retry with exponential backoff (1s, 4s, 9s;
  3 attempts). If all attempts fail, the meta-tool enters an "unavailable"
  state and `callTool` returns a clear error naming the crash reason, instead
  of the whole proxy process dying.
- **Call timeout.** `callTool` gets a default 30s timeout (override:
  `callTimeoutMs`), so one hung sub-tool call can't block the whole proxy.

Config schema additions are all optional — existing `proxy-config.json`
files keep working unchanged.

Testability: a fake stdio child MCP fixture (`test/fixtures/`) that can be
told to crash, hang, or respond slowly drives the reconnect/timeout tests
written in this phase (wired into CI in Phase 3).

## Phase 2 — MCP Feature Parity

Goal: the proxy currently only forwards the `tools` surface. Some child MCPs
(e.g. `filesystem`, `memory`) also expose `resources`/`prompts`, which are
silently dropped today.

- **Resources/prompts passthrough.** If a child advertises
  `capabilities.resources`/`capabilities.prompts`, the proxy also calls
  `resources/list`/`prompts/list` at connect time. It implements
  `ListResourcesRequestSchema`/`ListPromptsRequestSchema`, namespacing each
  entry as `"<childName>::<name>"` in one flat list (no separate router layer
  needed — reads are lower-risk than tool calls). `resources/read` and
  `prompts/get` route by the namespace prefix.
- **Lazy-start.** `"lazy": true` on a server config skips connecting it at
  proxy startup; the first `callTool` targeting that meta-tool triggers
  `connectChild()` on demand. Useful for expensive-to-start children (e.g.
  a browser) that aren't used every session.
- **Config hot-reload.** The proxy watches `proxy-config.json` (`fs.watch`,
  no new dependency). On change: newly added servers connect and a
  `notifications/tools/list_changed` is sent; removed/disabled servers are
  closed gracefully; servers whose `args`/`env` changed are restarted. This
  removes the current "restart both proxy and MCP client" requirement.
- **Per-server tool allowlist.** Optional `"toolAllowlist": [...]` on a
  server config restricts that meta-tool's `tool_name` enum (and what it will
  actually route) to the listed sub-tools — useful for large servers (e.g.
  a 190-tool DigitalOcean MCP) where only a handful of tools are wanted.

All additions are optional config fields; behavior for servers that don't use
them is unchanged.

## Phase 3 — Open-Source Hygiene / DX

Goal: the project is public but has no tests, no CI, and onboarding requires
a manual clone.

- **Tests.** Node's built-in `node:test` + `assert` (no new dependency).
  Fixtures from Phase 1/2 (normal, flaky, resource-capable fake servers) live
  under `test/fixtures/`. Coverage: config validation, `buildMetaTool` schema
  generation, router error/timeout behavior, reconnect logic, hot-reload.
  Fully fixture-driven — no dependency on real heavy MCPs like
  `@playwright/mcp`, so CI stays fast and deterministic.
- **GitHub Actions CI.** `.github/workflows/ci.yml` runs `npm ci && npm test`
  on push/PR across a Node 18/20 matrix. No lint/coverage gate yet (YAGNI —
  add later if the project grows).
- **npm publish.** Add a `bin` entry to `package.json` (with a `#!/usr/bin/env
  node` shebang) so users can run it via `npx` instead of cloning. (The name
  `mcp-proxy` may already be taken on npm — needs a pre-publish check; a
  different package name may be required.)
- **CONTRIBUTING.md + security/trust-model note.** Short contributor guide
  (how to run tests, PR expectations). A README section makes explicit that
  `command`/`args` in `proxy-config.json` are spawned directly, so the file
  must be trusted/self-authored — documentation only, no behavior change.

## Phase 4 — Agent-Facing UX

Goal: make the meta-tool interface easier for an LLM agent to use correctly.

- **"Did you mean" suggestions.** A small dependency-free Levenshtein-distance
  check suggests the 1-3 closest sub-tool names when `tool_name` doesn't
  match, instead of dumping the full tool list.
- **Result size capping.** If a `callTool` result exceeds a threshold
  (default 50KB, override `maxResultBytes`), the proxy truncates it with a
  `"...[truncated, N bytes total]"` note, so one oversized result (e.g. a
  screenshot) doesn't blow up the agent's context.
- **Better meta-tool descriptions.** Raise the per-sub-tool description
  truncation from 80 to 200 characters and flatten multi-line descriptions to
  one line. For servers with many sub-tools (>30), fall back to a name-only
  list plus a pointer to call with `tool_name` to see the full schema.
- **Tool search mode.** Calling a meta-tool with `{"search": "screenshot"}`
  instead of `tool_name`/`tool_input` returns the full input schema of
  matching sub-tools, without invoking anything — gives the agent a way to
  inspect a sub-tool's real parameters instead of relying on the shortened
  description.

All additions are backward compatible — the existing `tool_name`/`tool_input`
call shape is unchanged; `search` is a new optional path.

## Out of Scope (for now)

- Remote/HTTP transport for the proxy itself (stdio only).
- Auth/permission layer between agent and meta-tools.
- Plugin/extension architecture (considered and rejected as over-engineering
  for the current single-maintainer scale — revisit if contributor base
  grows).
