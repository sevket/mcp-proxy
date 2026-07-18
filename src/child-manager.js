import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { log } from "./logger.js";

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const RECONNECT_DELAYS_MS = [1_000, 4_000, 9_000];

export const clients = {};
export const toolMaps = {};
export const resourceMaps = {};
export const promptMaps = {};
export const configs = {};
export const unavailableReasons = {};
export const pendingLazy = new Set();

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function scheduleReconnect(name, serverCfg, attempt = 0) {
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

export async function connectChild(name, serverCfg) {
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
  pendingLazy.delete(name);
  toolMaps[name] = {};
  for (const tool of tools) {
    toolMaps[name][tool.name] = tool;
  }

  if (Array.isArray(serverCfg.toolAllowlist)) {
    const fullToolNames = new Set(Object.keys(toolMaps[name]));
    for (const toolName of fullToolNames) {
      if (!serverCfg.toolAllowlist.includes(toolName)) delete toolMaps[name][toolName];
    }
    const missing = serverCfg.toolAllowlist.filter((t) => !fullToolNames.has(t));
    if (missing.length > 0) {
      log(`[${name}] toolAllowlist references unknown tools: ${missing.join(", ")}`);
    }
  }

  const caps = client.getServerCapabilities();
  if (caps?.resources) {
    const { resources } = await client.listResources();
    resourceMaps[name] = {};
    for (const resource of resources) {
      resourceMaps[name][resource.uri] = resource;
    }
  } else {
    delete resourceMaps[name];
  }
  if (caps?.prompts) {
    const { prompts } = await client.listPrompts();
    promptMaps[name] = {};
    for (const prompt of prompts) {
      promptMaps[name][prompt.name] = prompt;
    }
  } else {
    delete promptMaps[name];
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

  log(
    `[${name}] ready — ${tools.length} tools` +
    (resourceMaps[name] ? `, ${Object.keys(resourceMaps[name]).length} resources` : "") +
    (promptMaps[name] ? `, ${Object.keys(promptMaps[name]).length} prompts` : "")
  );
  return tools;
}

export function disconnectChild(name) {
  const client = clients[name];
  if (client) {
    client.onclose = undefined;
    client.onerror = undefined;
    client.close().catch(() => {});
  }
  delete clients[name];
  delete toolMaps[name];
  delete resourceMaps[name];
  delete promptMaps[name];
  delete configs[name];
  delete unavailableReasons[name];
  pendingLazy.delete(name);
}
