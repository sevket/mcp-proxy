# mcp-proxy

A lightweight proxy that consolidates multiple [MCP](https://modelcontextprotocol.io) servers behind a single endpoint. Each child MCP server is exposed as **one meta-tool** — the agent sees N tools instead of hundreds, while retaining full access to every sub-tool.

## The Problem

MCP clients like Claude Desktop, Antigravity, and others enforce a **tool limit** (commonly 100). A single MCP server like `@digitalocean/mcp` alone registers 190+ tools. Add Playwright, Serena, or any others and you quickly exceed the limit — making it impossible to use multiple MCP servers together.

## The Solution

mcp-proxy sits between the agent and your MCP servers. It spawns each child MCP, discovers their tools, then exposes **one meta-tool per server** with `tool_name` and `tool_input` as parameters. The agent calls the meta-tool, and the proxy transparently routes the request to the correct child MCP.

```
Agent                 mcp-proxy              Child MCP Servers
──────                ─────────              ─────────────────
"playwright"  ──────►  route  ──────────────► @playwright/mcp       (23 tools)
"serena"      ──────►  route  ──────────────► serena                (28 tools)
"digitalocean"──────►  route  ──────────────► @digitalocean/mcp    (193 tools)

Agent sees: 3 tools                          Reality: 244 tools
```

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/sevket/mcp-proxy.git
cd mcp-proxy
npm install
```

### 2. Configure your MCP servers

Copy the example config and add your MCP servers:

```bash
cp proxy-config.example.json proxy-config.json
```

Edit `proxy-config.json` with your actual MCP servers. The format is identical to Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp"],
      "env": {}
    },
    "digitalocean": {
      "command": "npx",
      "args": ["-y", "@digitalocean/mcp", "--services", "apps,droplets,databases"],
      "env": {
        "DIGITALOCEAN_API_TOKEN": "your_token_here"
      }
    }
  }
}
```

### 3. Point your MCP client to the proxy

Instead of registering each MCP server individually, register only the proxy. Here is an example for Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mcp-proxy": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-proxy/index.js"],
      "env": {}
    }
  }
}
```

Restart your MCP client — you should see one tool per child MCP server.

## How It Works

1. **Startup** — The proxy reads `proxy-config.json` and spawns each child MCP server as a subprocess using stdio transport.
2. **Discovery** — It calls `tools/list` on each child to collect their available tools.
3. **Meta-tool generation** — For each child MCP, it creates a single meta-tool. The meta-tool's `description` lists all available sub-tools so the agent knows what's available. The `tool_name` parameter is an `enum` of all sub-tool names for precise routing.
4. **Request routing** — When the agent calls a meta-tool, the proxy extracts `tool_name` and `tool_input`, forwards the request to the correct child MCP, and returns the response as-is.

### Meta-tool Schema

Each meta-tool accepts two parameters:

| Parameter    | Type     | Description                              |
|------------- |----------|------------------------------------------|
| `tool_name`  | `string` | Name of the sub-tool to call (enum)      |
| `tool_input` | `object` | Arguments to pass to the sub-tool        |

## Adding a New MCP Server

Add a new entry to `proxy-config.json` and restart the proxy:

```json
{
  "mcpServers": {
    "existing-mcp": { "..." : "..." },
    "new-mcp": {
      "command": "npx",
      "args": ["-y", "@some/mcp-package"]
    }
  }
}
```

The new MCP server will automatically appear as a meta-tool.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Child MCP fails to connect | Check the `command` path and `env.PATH` in `proxy-config.json`. Use absolute paths if needed. |
| Tool not found | Check proxy logs in stderr. Verify the tool exists in the child MCP. |
| Agent doesn't see updated tools | Restart both the proxy and the MCP client. |
| Partial startup | The proxy continues even if some children fail — check logs for errors. |

## Requirements

- Node.js 18+
- npm

## License

MIT
