import { readFileSync, watch } from "fs";
import { basename, dirname } from "path";
import { log } from "./logger.js";

const RELOAD_DEBOUNCE_MS = 300;

export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== "object" || typeof cfg.mcpServers !== "object" || cfg.mcpServers === null) {
    throw new Error('proxy-config.json must have a top-level "mcpServers" object.');
  }

  for (const [name, serverCfg] of Object.entries(cfg.mcpServers)) {
    if (!serverCfg || typeof serverCfg.command !== "string" || serverCfg.command.length === 0) {
      throw new Error(`server "${name}" is missing a valid "command" string.`);
    }
    if (serverCfg.args !== undefined && !Array.isArray(serverCfg.args)) {
      throw new Error(`server "${name}".args must be an array if present.`);
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

export function loadConfig(configPath) {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    validateConfig(raw);
    return raw;
  } catch (err) {
    console.error(`mcp-proxy: ${err.message}`);
    process.exit(1);
  }
}

export function readAndValidateConfig(configPath) {
  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  validateConfig(raw);
  return raw;
}

export function watchConfigFile(configPath, onChange) {
  // Watch the parent directory, not the file itself: editors and tools that
  // save atomically (write a temp file, then rename over the target) replace
  // the file's inode, which silently stops a watch bound to the old inode.
  // The directory's inode doesn't change, so this survives atomic saves.
  const dir = dirname(configPath);
  const target = basename(configPath);
  let reloadTimer = null;
  try {
    const watcher = watch(dir, (_eventType, filename) => {
      if (filename !== null && filename !== target) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(onChange, RELOAD_DEBOUNCE_MS);
    });
    watcher.on("error", (err) => log(`config watcher error: ${err.message}`));
    log(`watching ${configPath} for changes`);
  } catch (err) {
    log(`could not watch config file for hot-reload: ${err.message}`);
  }
}
