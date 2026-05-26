import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(join(__dirname, "proxy-config.json"), "utf-8")
);

const clients = {};
const toolMaps = {};

async function connectChild(name, serverCfg) {
  log(`Connecting to [${name}]...`);

  const client = new Client(
    { name: `mcp-proxy/${name}`, version: "1.0.0" },
    { capabilities: {} }
  );

  const transport = new StdioClientTransport({
    command: serverCfg.command,
    args: serverCfg.args || [],
    env: { ...process.env, ...(serverCfg.env || {}) },
  });

  await client.connect(transport);

  const { tools } = await client.listTools();

  clients[name] = client;
  toolMaps[name] = {};
  for (const tool of tools) {
    toolMaps[name][tool.name] = tool;
  }

  log(`[${name}] ready — ${tools.length} tools`);
  return tools;
}

function buildMetaTool(mcpName) {
  const subTools = toolMaps[mcpName];
  const toolNames = Object.keys(subTools);

  const toolSummaries = toolNames
    .map((t) => `${t}: ${(subTools[t].description || "").slice(0, 80)}`)
    .join("\n");

  return {
    name: mcpName,
    description:
      `Proxy to the "${mcpName}" MCP server.\n` +
      `Pass tool_name (one of ${toolNames.length} tools) and tool_input.\n\n` +
      `Available tools:\n${toolSummaries}`,
    inputSchema: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: `Which tool to call inside ${mcpName}.`,
          enum: toolNames,
        },
        tool_input: {
          type: "object",
          description: "Arguments for the chosen tool (as defined by that tool's schema).",
        },
      },
      required: ["tool_name", "tool_input"],
    },
  };
}

async function main() {
  const entries = Object.entries(config.mcpServers);

  for (const [name, serverCfg] of entries) {
    try {
      await connectChild(name, serverCfg);
    } catch (err) {
      log(`ERROR connecting to [${name}]: ${err.message}`);
    }
  }

  const readyMCPs = Object.keys(clients);
  log(`Proxy ready. Exposing ${readyMCPs.length} meta-tools: ${readyMCPs.join(", ")}`);

  const server = new Server(
    { name: "mcp-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: Object.keys(toolMaps).map(buildMetaTool) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: mcpName, arguments: args } = request.params;
    const { tool_name, tool_input } = args ?? {};

    const client = clients[mcpName];
    if (!client) {
      return error(`MCP "${mcpName}" is not connected.`);
    }

    if (!tool_name) {
      return error(`"tool_name" is required. Available: ${Object.keys(toolMaps[mcpName]).join(", ")}`);
    }

    if (!toolMaps[mcpName][tool_name]) {
      return error(
        `Tool "${tool_name}" not found in "${mcpName}". ` +
        `Available: ${Object.keys(toolMaps[mcpName]).join(", ")}`
      );
    }

    try {
      return await client.callTool({
        name: tool_name,
        arguments: tool_input ?? {},
      });
    } catch (e) {
      return error(`${mcpName}.${tool_name} failed: ${e.message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Listening on stdio.");
}

function log(msg) {
  process.stderr.write(`[mcp-proxy] ${msg}\n`);
}

function error(msg) {
  return {
    content: [{ type: "text", text: msg }],
    isError: true,
  };
}

main().catch((e) => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
