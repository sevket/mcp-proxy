import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildMetaTool } from "./meta-tool.js";
import { closestMatches } from "./fuzzy-match.js";
import {
  clients,
  toolMaps,
  resourceMaps,
  promptMaps,
  configs,
  unavailableReasons,
  pendingLazy,
  connectChild,
  withTimeout,
  DEFAULT_CALL_TIMEOUT_MS,
} from "./child-manager.js";

const NS_DELIM = "::";
const DEFAULT_MAX_RESULT_BYTES = 50_000;

function capContentSize(result, maxBytes) {
  if (!result || !Array.isArray(result.content)) return result;
  const content = result.content.map((block) => {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > maxBytes) {
      const total = block.text.length;
      return { ...block, text: `${block.text.slice(0, maxBytes)}\n...[truncated, ${total} bytes total]` };
    }
    return block;
  });
  return { ...result, content };
}

function splitNamespaced(id) {
  const idx = id.indexOf(NS_DELIM);
  if (idx === -1) {
    throw new Error(`Expected a namespaced id ("childName${NS_DELIM}id"), got "${id}".`);
  }
  return { childName: id.slice(0, idx), id: id.slice(idx + NS_DELIM.length) };
}

function error(msg) {
  return {
    content: [{ type: "text", text: msg }],
    isError: true,
  };
}

export function registerHandlers(server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: Object.keys(toolMaps).map(buildMetaTool) };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [];
    for (const [childName, map] of Object.entries(resourceMaps)) {
      for (const resource of Object.values(map)) {
        resources.push({ ...resource, uri: `${childName}${NS_DELIM}${resource.uri}` });
      }
    }
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const { childName, id: originalUri } = splitNamespaced(uri);
    const client = clients[childName];
    if (!client) throw new Error(`MCP "${childName}" is not connected.`);
    return client.readResource({ uri: originalUri });
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    const prompts = [];
    for (const [childName, map] of Object.entries(promptMaps)) {
      for (const prompt of Object.values(map)) {
        prompts.push({ ...prompt, name: `${childName}${NS_DELIM}${prompt.name}` });
      }
    }
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const { childName, id: originalName } = splitNamespaced(name);
    const client = clients[childName];
    if (!client) throw new Error(`MCP "${childName}" is not connected.`);
    return client.getPrompt({ name: originalName, arguments: args });
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name: mcpName, arguments: args } = request.params;
    const { tool_name, tool_input } = args ?? {};

    if (pendingLazy.has(mcpName)) {
      try {
        await connectChild(mcpName, configs[mcpName]);
        server.sendToolListChanged().catch(() => {});
      } catch (err) {
        unavailableReasons[mcpName] = `lazy connection failed: ${err.message}`;
        pendingLazy.delete(mcpName);
        return error(`MCP "${mcpName}" failed to start: ${err.message}`);
      }
    }

    const client = clients[mcpName];
    if (!client) {
      if (unavailableReasons[mcpName]) {
        return error(`MCP "${mcpName}" is unavailable: ${unavailableReasons[mcpName]}`);
      }
      return error(`MCP "${mcpName}" is not connected.`);
    }

    if (typeof args?.search === "string") {
      const term = args.search.toLowerCase();
      const matches = Object.values(toolMaps[mcpName]).filter(
        (t) => t.name.toLowerCase().includes(term) || (t.description || "").toLowerCase().includes(term)
      );
      return {
        content: [
          {
            type: "text",
            text:
              matches.length > 0
                ? JSON.stringify(matches, null, 2)
                : `No tools matching "${args.search}" found in "${mcpName}".`,
          },
        ],
      };
    }

    if (!tool_name) {
      return error(`"tool_name" is required. Available: ${Object.keys(toolMaps[mcpName]).join(", ")}`);
    }

    if (!toolMaps[mcpName][tool_name]) {
      const suggestions = closestMatches(tool_name, Object.keys(toolMaps[mcpName]));
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
      return error(
        `Tool "${tool_name}" not found in "${mcpName}".${hint} ` +
        `Available: ${Object.keys(toolMaps[mcpName]).join(", ")}`
      );
    }

    const callTimeoutMs = (configs[mcpName] && configs[mcpName].callTimeoutMs) || DEFAULT_CALL_TIMEOUT_MS;
    const maxResultBytes = (configs[mcpName] && configs[mcpName].maxResultBytes) || DEFAULT_MAX_RESULT_BYTES;

    try {
      const result = await withTimeout(
        client.callTool({ name: tool_name, arguments: tool_input ?? {} }),
        callTimeoutMs,
        `${mcpName}.${tool_name} timed out after ${callTimeoutMs}ms`
      );
      return capContentSize(result, maxResultBytes);
    } catch (e) {
      return error(`${mcpName}.${tool_name} failed: ${e.message}`);
    }
  });
}
