import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { registerHandlers } from "../src/router.js";
import {
  connectChild,
  disconnectChild,
  configs,
  toolMaps,
  pendingLazy,
} from "../src/child-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "fake-mcp-server.js");

async function makeConnectedTestClient() {
  const server = new Server(
    { name: "test-proxy", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } }
  );
  registerHandlers(server);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test("callTool routes to the right sub-tool and rejects unknown tool names", async () => {
  const { client } = await makeConnectedTestClient();
  await connectChild("thing", { command: "node", args: [FIXTURE] });
  try {
    const ok = await client.callTool({
      name: "thing",
      arguments: { tool_name: "add", tool_input: { a: 2, b: 3 } },
    });
    assert.equal(ok.content[0].text, "5");

    const bad = await client.callTool({
      name: "thing",
      arguments: { tool_name: "nope", tool_input: {} },
    });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /not found in "thing"/);
  } finally {
    disconnectChild("thing");
  }
});

test("callTool on a lazy server connects on first use", async () => {
  const { client } = await makeConnectedTestClient();
  configs.lazything = { command: "node", args: [FIXTURE] };
  toolMaps.lazything = null;
  pendingLazy.add("lazything");
  try {
    const tools = await client.listTools();
    const meta = tools.tools.find((t) => t.name === "lazything");
    assert.equal(meta.inputSchema.properties.tool_name.enum, undefined);

    const result = await client.callTool({
      name: "lazything",
      arguments: { tool_name: "echo", tool_input: { text: "hi" } },
    });
    assert.equal(result.content[0].text, "hi");
    assert.equal(pendingLazy.has("lazything"), false);
  } finally {
    disconnectChild("lazything");
  }
});

test("callTool reports a clear unavailable reason for a server that never connected", async () => {
  const { client } = await makeConnectedTestClient();
  const result = await client.callTool({
    name: "doesNotExist",
    arguments: { tool_name: "x", tool_input: {} },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not connected/);
});

test("callTool suggests the closest tool name on a typo", async () => {
  const { client } = await makeConnectedTestClient();
  await connectChild("thing", { command: "node", args: [FIXTURE] });
  try {
    const result = await client.callTool({
      name: "thing",
      arguments: { tool_name: "ad", tool_input: {} },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Did you mean: add/);
  } finally {
    disconnectChild("thing");
  }
});

test("callTool search mode returns matching sub-tool schemas without calling anything", async () => {
  const { client } = await makeConnectedTestClient();
  await connectChild("thing", { command: "node", args: [FIXTURE] });
  try {
    const result = await client.callTool({
      name: "thing",
      arguments: { search: "add" },
    });
    const matches = JSON.parse(result.content[0].text);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].name, "add");
    assert.ok(matches[0].inputSchema);

    const noMatches = await client.callTool({
      name: "thing",
      arguments: { search: "nonexistent" },
    });
    assert.match(noMatches.content[0].text, /No tools matching/);
  } finally {
    disconnectChild("thing");
  }
});

test("callTool caps oversized text results", async () => {
  const { client } = await makeConnectedTestClient();
  await connectChild("thing", { command: "node", args: [FIXTURE], maxResultBytes: 50 });
  try {
    const bigText = "x".repeat(200);
    const result = await client.callTool({
      name: "thing",
      arguments: { tool_name: "echo", tool_input: { text: bigText } },
    });
    assert.ok(result.content[0].text.startsWith("x".repeat(50)));
    assert.match(result.content[0].text, /truncated, 200 bytes total/);
  } finally {
    disconnectChild("thing");
  }
});

test("callTool enforces the per-call timeout", async () => {
  const { client } = await makeConnectedTestClient();
  await connectChild("slow", {
    command: "node",
    args: [FIXTURE, "--slow-tool-ms=500"],
    callTimeoutMs: 100,
  });
  try {
    const result = await client.callTool({
      name: "slow",
      arguments: { tool_name: "echo", tool_input: { text: "hi" } },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /timed out/);
  } finally {
    disconnectChild("slow");
  }
});
