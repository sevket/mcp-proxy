import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMetaTool } from "../src/meta-tool.js";
import { toolMaps } from "../src/child-manager.js";

test("buildMetaTool returns a permissive schema for a lazy (unconnected) server", () => {
  toolMaps.lazyThing = null;
  try {
    const meta = buildMetaTool("lazyThing");
    assert.equal(meta.name, "lazyThing");
    assert.match(meta.description, /lazy/i);
    assert.equal(meta.inputSchema.properties.tool_name.enum, undefined);
    assert.deepEqual(meta.inputSchema.required, ["tool_name", "tool_input"]);
  } finally {
    delete toolMaps.lazyThing;
  }
});

test("buildMetaTool returns an enum of the discovered tools for a connected server", () => {
  toolMaps.thing = {
    echo: { name: "echo", description: "Echoes input back, verbatim, no changes made at all" },
    add: { name: "add", description: "Adds two numbers" },
  };
  try {
    const meta = buildMetaTool("thing");
    assert.equal(meta.name, "thing");
    assert.deepEqual(meta.inputSchema.properties.tool_name.enum, ["echo", "add"]);
    assert.match(meta.description, /2 tools/);
    assert.match(meta.description, /echo:/);
    assert.match(meta.description, /add:/);
  } finally {
    delete toolMaps.thing;
  }
});

test("buildMetaTool truncates long sub-tool descriptions to 80 chars in the summary", () => {
  const longDescription = "x".repeat(200);
  toolMaps.thing = { one: { name: "one", description: longDescription } };
  try {
    const meta = buildMetaTool("thing");
    const summaryLine = meta.description.split("\n").find((l) => l.startsWith("one:"));
    assert.equal(summaryLine.length, "one: ".length + 80);
  } finally {
    delete toolMaps.thing;
  }
});
