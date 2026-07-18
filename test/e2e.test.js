import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_ENTRY = join(__dirname, "..", "index.js");
const FIXTURE = join(__dirname, "fixtures", "fake-mcp-server.js");

function writeConfig(dir, mcpServers) {
  writeFileSync(join(dir, "proxy-config.json"), JSON.stringify({ mcpServers }));
}

// index.js resolves proxy-config.json relative to process.cwd(), so pointing
// a test run at a throwaway config is just a matter of running the real
// entry point with cwd set to a temp dir holding that config.
async function startProxy(dir) {
  const client = new Client({ name: "e2e-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: "node",
    args: [PROXY_ENTRY],
    cwd: dir,
    env: { ...process.env },
  });
  await client.connect(transport);
  return client;
}

test("full proxy: lists real meta-tools and routes a real callTool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-proxy-e2e-"));
  writeConfig(dir, { thing: { command: "node", args: [FIXTURE] } });
  const client = await startProxy(dir);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["thing"]);

    const result = await client.callTool({
      name: "thing",
      arguments: { tool_name: "add", tool_input: { a: 10, b: 5 } },
    });
    assert.equal(result.content[0].text, "15");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full proxy: hot-reload adds a new server without restarting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-proxy-e2e-"));
  writeConfig(dir, { first: { command: "node", args: [FIXTURE] } });
  const client = await startProxy(dir);
  try {
    let tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name), ["first"]);

    writeConfig(dir, {
      first: { command: "node", args: [FIXTURE] },
      second: { command: "node", args: [FIXTURE] },
    });

    // The proxy watches the config directory and debounces reloads; poll
    // for the new meta-tool to show up instead of guessing a fixed delay.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      tools = (await client.listTools()).tools;
      if (tools.some((t) => t.name === "second")) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.deepEqual(tools.map((t) => t.name).sort(), ["first", "second"]);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full proxy: exits with a clear error (no stack trace) on invalid config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-proxy-e2e-"));
  writeFileSync(join(dir, "proxy-config.json"), "{ not json");
  const { spawnSync } = await import("child_process");
  try {
    const result = spawnSync(process.execPath, [PROXY_ENTRY], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mcp-proxy:/);
    assert.doesNotMatch(result.stderr, /at .*\.js:\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
