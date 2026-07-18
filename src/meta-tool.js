import { toolMaps } from "./child-manager.js";

const DESCRIPTION_TRUNCATE_LENGTH = 200;
const MANY_TOOLS_THRESHOLD = 30;

const SEARCH_PROPERTY = {
  type: "string",
  description:
    'Alternative to tool_name/tool_input: look up matching sub-tools by name/description and get their full input schema back, without calling anything. Use this instead of tool_name/tool_input, e.g. {"search": "screenshot"}.',
};

function flattenWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

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
          search: SEARCH_PROPERTY,
        },
        anyOf: [{ required: ["tool_name", "tool_input"] }, { required: ["search"] }],
      },
    };
  }

  const toolNames = Object.keys(subTools);
  const toolSummaries =
    toolNames.length > MANY_TOOLS_THRESHOLD
      ? `${toolNames.join(", ")}\n\n(${toolNames.length} tools — call with tool_name=<name> to try one, or {"search": "<term>"} to see a matching tool's full schema.)`
      : toolNames
          .map((t) => `${t}: ${flattenWhitespace(subTools[t].description || "").slice(0, DESCRIPTION_TRUNCATE_LENGTH)}`)
          .join("\n");

  return {
    name: mcpName,
    description:
      `Proxy to the "${mcpName}" MCP server.\n` +
      `Pass tool_name (one of ${toolNames.length} tools) and tool_input. ` +
      `Or pass {"search": "<term>"} instead to look up a tool's full schema.\n\n` +
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
        search: SEARCH_PROPERTY,
      },
      anyOf: [{ required: ["tool_name", "tool_input"] }, { required: ["search"] }],
    },
  };
}
