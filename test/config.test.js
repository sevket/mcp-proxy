import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { validateConfig, readAndValidateConfig } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("validateConfig accepts a minimal valid config", () => {
  assert.doesNotThrow(() => validateConfig({ mcpServers: { a: { command: "node" } } }));
});

test("validateConfig throws when mcpServers is missing", () => {
  assert.throws(() => validateConfig({}), /mcpServers/);
});

test("validateConfig throws when mcpServers is not an object", () => {
  assert.throws(() => validateConfig({ mcpServers: "nope" }), /mcpServers/);
});

test("validateConfig throws when a server is missing command", () => {
  assert.throws(() => validateConfig({ mcpServers: { a: {} } }), /command/);
});

test("validateConfig throws when args is not an array", () => {
  assert.throws(
    () => validateConfig({ mcpServers: { a: { command: "node", args: "not-an-array" } } }),
    /args/
  );
});

test("validateConfig warns but does not throw on empty env values", () => {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    assert.doesNotThrow(() =>
      validateConfig({ mcpServers: { a: { command: "node", env: { FOO: "" } } } })
    );
  } finally {
    process.stderr.write = original;
  }
  assert.match(captured, /WARNING.*empty env value.*FOO/);
});

test("readAndValidateConfig parses and validates a config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-proxy-test-"));
  const configPath = join(dir, "proxy-config.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: { a: { command: "node" } } }));
  try {
    const cfg = readAndValidateConfig(configPath);
    assert.deepEqual(cfg, { mcpServers: { a: { command: "node" } } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAndValidateConfig throws (does not exit) on invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-proxy-test-"));
  const configPath = join(dir, "proxy-config.json");
  writeFileSync(configPath, "{ not json");
  try {
    assert.throws(() => readAndValidateConfig(configPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig exits the process with a clear message on invalid config", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-proxy-test-"));
  const configPath = join(dir, "proxy-config.json");
  writeFileSync(configPath, "{ not json");
  const runner = join(__dirname, "fixtures", "load-config-runner.js");
  try {
    // loadConfig() calls process.exit() on failure, so it can only be
    // exercised as a real subprocess, not called in-process here.
    const result = spawnSync(process.execPath, [runner, configPath], { encoding: "utf-8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mcp-proxy:/);
    assert.doesNotMatch(result.stderr, /at .*\.js:\d+/); // no stack trace
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig succeeds silently on a valid config", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-proxy-test-"));
  const configPath = join(dir, "proxy-config.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: { a: { command: "node" } } }));
  const runner = join(__dirname, "fixtures", "load-config-runner.js");
  try {
    const result = spawnSync(process.execPath, [runner, configPath], { encoding: "utf-8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /loaded ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
