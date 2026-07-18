import { toolMaps } from "./child-manager.js";

export function buildMetaTool(mcpName) {
  const subTools = toolMaps[mcpName];

  if (subTools === null) {
    return {
      name: mcpName,
      description:
        `Proxy to the "${mcpName}" MCP server (lazy — not yet connected). ` +
        `Its tool list is unknown until first use; calling this with any tool_name ` +
        `connects it and, if the name is wrong, replies with the real list.`,
      inputSchema: {
        type: "object",
        properties: {
          tool_name: {
            type: "string",
            description: `Which tool to call inside ${mcpName}. Exact names are unknown until first connection.`,
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
