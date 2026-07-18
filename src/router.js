import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { buildMetaTool } from "./meta-tool.js";
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
}
