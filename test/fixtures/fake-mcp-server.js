#!/usr/bin/env node
// A minimal, flag-driven stdio MCP server used by the test suite instead of
// spawning real (slow, network-dependent) MCP packages. Behavior is selected
// via CLI flags so one file covers the "normal / crashing / resource-capable"
// scenarios the test suite needs:
//
//   --with-resources         also expose one resource and one prompt
//   --crash-after-ms=N       exit(1) N ms after startup, to test crash/reconnect
//   --crash-once-file=PATH   with --crash-after-ms, only crash the first time
//                            (marked by creating PATH) so a reconnect test can
//                            observe a single, deterministic crash-then-recover
//                            cycle instead of a repeating crash loop
//   --slow-tool-ms=N         every tool call waits N ms before resolving
//   --hang-connect           never starts the transport, to test connect timeouts
import { existsSync, writeFileSync } from "fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
function flag(name, fallback) {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

if (has("hang-connect")) {
  setInterval(() => {}, 1 << 30);
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

async function main() {
  const withResources = has("with-resources");
  const crashAfterMs = flag("crash-after-ms", null);
  const slowToolMs = Number(flag("slow-tool-ms", "0"));

  const capabilities = { tools: {} };
  if (withResources) {
    capabilities.resources = {};
    capabilities.prompts = {};
  }

  const server = new Server({ name: "fake-mcp-server", version: "1.0.0" }, { capabilities });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echoes the input text back.",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
      {
        name: "add",
        description: "Adds two numbers.",
        inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (slowToolMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, slowToolMs));
    }
    const { name, arguments: a } = request.params;
    if (name === "echo") {
      return { content: [{ type: "text", text: String(a?.text ?? "") }] };
    }
    if (name === "add") {
      return { content: [{ type: "text", text: String((a?.a ?? 0) + (a?.b ?? 0)) }] };
    }
    return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  });

  if (withResources) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: "note://hello", name: "hello", mimeType: "text/plain" }],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
      contents: [{ uri: request.params.uri, text: "hello world" }],
    }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{ name: "greet", description: "Says hi." }],
    }));
    server.setRequestHandler(GetPromptRequestSchema, async () => ({
      messages: [{ role: "user", content: { type: "text", text: "hi there" } }],
    }));
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (crashAfterMs !== null) {
    const crashOnceFile = flag("crash-once-file", null);
    const alreadyCrashedOnce = crashOnceFile !== null && existsSync(crashOnceFile);
    if (!alreadyCrashedOnce) {
      if (crashOnceFile !== null) writeFileSync(crashOnceFile, "");
      setTimeout(() => process.exit(1), Number(crashAfterMs));
    }
  }
}
