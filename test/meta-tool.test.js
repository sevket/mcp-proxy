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
    assert.deepEqual(meta.inputSchema.anyOf, [
      { required: ["tool_name", "tool_input"] },
      { required: ["search"] },
    ]);
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
    assert.ok(meta.inputSchema.properties.search);
    assert.match(meta.description, /2 tools/);
    assert.match(meta.description, /echo:/);
    assert.match(meta.description, /add:/);
  } finally {
    delete toolMaps.thing;
  }
});

test("buildMetaTool truncates long sub-tool descriptions to 200 chars in the summary", () => {
  const longDescription = "x".repeat(400);
  toolMaps.thing = { one: { name: "one", description: longDescription } };
  try {
    const meta = buildMetaTool("thing");
    const summaryLine = meta.description.split("\n").find((l) => l.startsWith("one:"));
    assert.equal(summaryLine.length, "one: ".length + 200);
  } finally {
    delete toolMaps.thing;
  }
});

test("buildMetaTool flattens multi-line descriptions before truncating", () => {
  toolMaps.thing = { one: { name: "one", description: "line one\nline  two\tline three" } };
  try {
    const meta = buildMetaTool("thing");
    const summaryLine = meta.description.split("\n").find((l) => l.startsWith("one:"));
    assert.equal(summaryLine, "one: line one line two line three");
  } finally {
    delete toolMaps.thing;
  }
});

test("buildMetaTool falls back to a name-only list when there are many sub-tools", () => {
  toolMaps.thing = {};
  for (let i = 0; i < 31; i++) {
    toolMaps.thing[`tool${i}`] = { name: `tool${i}`, description: "does something" };
  }
  try {
    const meta = buildMetaTool("thing");
    assert.doesNotMatch(meta.description, /does something/);
    assert.match(meta.description, /tool0, tool1/);
    assert.match(meta.description, /31 tools/);
  } finally {
    delete toolMaps.thing;
  }
});
