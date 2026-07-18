import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 4_000, 9_000];

let config;
try {
  config = JSON.parse(readFileSync(join(__dirname, "proxy-config.json"), "utf-8"));
} catch (err) {
  console.error(`mcp-proxy: could not read proxy-config.json: ${err.message}`);
  process.exit(1);
}
validateConfig(config);

const clients = {};
const toolMaps = {};
const configs = {};
const unavailableReasons = {};

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== "object" || typeof cfg.mcpServers !== "object" || cfg.mcpServers === null) {
    console.error('mcp-proxy: proxy-config.json must have a top-level "mcpServers" object.');
    process.exit(1);
  }

  for (const [name, serverCfg] of Object.entries(cfg.mcpServers)) {
    if (!serverCfg || typeof serverCfg.command !== "string" || serverCfg.command.length === 0) {
      console.error(`mcp-proxy: server "${name}" is missing a valid "command" string.`);
      process.exit(1);
    }
    if (serverCfg.args !== undefined && !Array.isArray(serverCfg.args)) {
      console.error(`mcp-proxy: server "${name}".args must be an array if present.`);
      process.exit(1);
    }
    if (serverCfg.env && typeof serverCfg.env === "object") {
      for (const [key, value] of Object.entries(serverCfg.env)) {
        if (value === "") {
          log(`WARNING: server "${name}" has an empty env value for "${key}" — the child may fail to start.`);
        }
      }
    }
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function scheduleReconnect(name, serverCfg, attempt = 0) {
  if (attempt >= RECONNECT_DELAYS_MS.length) {
    unavailableReasons[name] = "child crashed and failed to reconnect after 3 attempts";
    delete clients[name];
    log(`[${name}] giving up after ${RECONNECT_DELAYS_MS.length} reconnect attempts`);
    return;
  }

  const delay = RECONNECT_DELAYS_MS[attempt];
  log(`[${name}] disconnected — reconnecting in ${delay}ms (attempt ${attempt + 1}/${RECONNECT_DELAYS_MS.length})`);
  setTimeout(async () => {
    try {
      await connectChild(name, serverCfg);
      delete unavailableReasons[name];
      log(`[${name}] reconnected`);
    } catch (err) {
      log(`[${name}] reconnect attempt ${attempt + 1} failed: ${err.message}`);
      scheduleReconnect(name, serverCfg, attempt + 1);
    }
  }, delay);
}

async function connectChild(name, serverCfg) {
  log(`Connecting to [${name}]...`);
  configs[name] = serverCfg;

  const client = new Client(
    { name: `mcp-proxy/${name}`, version: "1.0.0" },
    { capabilities: {} }
  );

  const transport = new StdioClientTransport({
    command: serverCfg.command,
    args: serverCfg.args || [],
    env: { ...process.env, ...(serverCfg.env || {}) },
  });

  await withTimeout(
    client.connect(transport),
    serverCfg.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS,
    `[${name}] connect timed out after ${serverCfg.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS}ms`
  );

  const { tools } = await client.listTools();

  clients[name] = client;
  toolMaps[name] = {};
  for (const tool of tools) {
    toolMaps[name][tool.name] = tool;
  }

  client.onclose = () => {
    if (clients[name] === client) {
      delete clients[name];
      scheduleReconnect(name, serverCfg);
    }
  };
  client.onerror = (err) => {
    log(`[${name}] transport error: ${err.message}`);
  };

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
    if (serverCfg.disabled) {
      log(`[${name}] skipped (disabled)`);
      continue;
    }
    try {
      await connectChild(name, serverCfg);
    } catch (err) {
      log(`ERROR connecting to [${name}]: ${err.message}`);
      unavailableReasons[name] = `initial connection failed: ${err.message}`;
      configs[name] = serverCfg;
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
      if (unavailableReasons[mcpName]) {
        return error(`MCP "${mcpName}" is unavailable: ${unavailableReasons[mcpName]}`);
      }
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

    const callTimeoutMs = (configs[mcpName] && configs[mcpName].callTimeoutMs) || DEFAULT_CALL_TIMEOUT_MS;

    try {
      return await withTimeout(
        client.callTool({ name: tool_name, arguments: tool_input ?? {} }),
        callTimeoutMs,
        `${mcpName}.${tool_name} timed out after ${callTimeoutMs}ms`
      );
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
