# Contributing

## Setup

```bash
git clone https://github.com/sevket/mcp-proxy.git
cd mcp-proxy
npm install
```

## Running tests

```bash
npm test
```

Tests use Node's built-in test runner (`node:test`) against small fake MCP servers in `test/fixtures/` — no real MCP packages, network access, or API keys are needed. Test files matching `test/*.test.js` run; anything under `test/fixtures/` is support code, not a test itself.

## Making changes

- Keep `proxy-config.json` out of commits — it's gitignored since it's meant to hold your own local server list (and sometimes secrets like API tokens). Edit `proxy-config.example.json` instead if you're changing the documented config shape.
- If you add a feature, add or extend a test in `test/`. Prefer a fake server fixture (`test/fixtures/fake-mcp-server.js`, extend its CLI flags if you need new behavior) over spawning a real MCP package, so CI stays fast and deterministic.
- Run `npm test` before opening a PR.

## Pull requests

Describe what changed and why. Link an issue if there is one. Small, focused PRs are easier to review than large ones.
