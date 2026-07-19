#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { log } from "./src/logger.js";
import { loadConfig, readAndValidateConfig, watchConfigFile } from "./src/config.js";
import {
  clients,
  toolMaps,
  configs,
  unavailableReasons,
  pendingLazy,
  connectChild,
  disconnectChild,
} from "./src/child-manager.js";
import { registerHandlers } from "./src/router.js";

// Prefer the current working directory (so a global/npx install picks up
// the config in whatever directory the user runs it from) but fall back to
// the script's own directory if there's no config at cwd — this keeps
// working for an existing setup that points an MCP client straight at
// index.js's absolute path without also setting a matching "cwd".
function resolveConfigPath() {
  const cwdPath = join(process.cwd(), "proxy-config.json");
  if (existsSync(cwdPath)) return cwdPath;
  return join(dirname(fileURLToPath(import.meta.url)), "proxy-config.json");
}

const CONFIG_PATH = resolveConfigPath();

let config = loadConfig(CONFIG_PATH);
let server;

async function connectOrMarkLazy(name, serverCfg) {
  configs[name] = serverCfg;
  if (serverCfg.lazy) {
    toolMaps[name] = null;
    pendingLazy.add(name);
    log(`[${name}] lazy — will connect on first use`);
    return;
  }
  try {
    await connectChild(name, serverCfg);
  } catch (err) {
    log(`ERROR connecting to [${name}]: ${err.message}`);
    unavailableReasons[name] = `initial connection failed: ${err.message}`;
  }
}

async function reloadConfig() {
  let newConfig;
  try {
    newConfig = readAndValidateConfig(CONFIG_PATH);
  } catch (err) {
    log(`config reload failed, keeping previous config: ${err.message}`);
    return;
  }

  const oldServers = config.mcpServers;
  const newServers = newConfig.mcpServers;
  const allNames = new Set([...Object.keys(oldServers), ...Object.keys(newServers)]);

  for (const name of allNames) {
    const prevCfg = oldServers[name];
    const nextCfg = newServers[name];
    const wasActive = prevCfg && !prevCfg.disabled;
    const isActive = nextCfg && !nextCfg.disabled;

    if (wasActive && !isActive) {
      disconnectChild(name);
      log(`[${name}] removed/disabled via hot-reload`);
      continue;
    }
    if (!isActive) continue;

    const isNew = !wasActive;
    const changed = !isNew && JSON.stringify(prevCfg) !== JSON.stringify(nextCfg);
    if (!isNew && !changed) continue;

    if (changed) disconnectChild(name);
    await connectOrMarkLazy(name, nextCfg);
  }

  config = newConfig;
  server.sendToolListChanged().catch(() => {});
  log("config reloaded");
}

async function main() {
  for (const [name, serverCfg] of Object.entries(config.mcpServers)) {
    if (serverCfg.disabled) {
      log(`[${name}] skipped (disabled)`);
      continue;
    }
    await connectOrMarkLazy(name, serverCfg);
  }

  const readyMCPs = Object.keys(clients);
  log(`Proxy ready. Exposing ${readyMCPs.length} meta-tools: ${readyMCPs.join(", ")}`);

  server = new Server(
    { name: "mcp-proxy", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } }
  );

  registerHandlers(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Listening on stdio.");

  watchConfigFile(CONFIG_PATH, () => {
    reloadConfig().catch((err) => log(`config reload error: ${err.message}`));
  });
}

main().catch((e) => {
  log(`Fatal: ${e.message}`);
  process.exit(1);
});
