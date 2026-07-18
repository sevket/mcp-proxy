import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  connectChild,
  disconnectChild,
  scheduleReconnect,
  clients,
  toolMaps,
  resourceMaps,
  promptMaps,
  unavailableReasons,
} from "../src/child-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "fake-mcp-server.js");

async function withCapturedStderrAsync(fn, onCaptured) {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk) => {
    captured += chunk;
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  onCaptured(captured);
}

test("connectChild discovers tools from a real child MCP", async () => {
  await connectChild("thing", { command: "node", args: [FIXTURE] });
  try {
    assert.ok(clients.thing);
    assert.deepEqual(Object.keys(toolMaps.thing), ["echo", "add"]);
  } finally {
    disconnectChild("thing");
  }
});

test("connectChild filters tools by toolAllowlist and warns on unknown names", async () => {
  let logged = "";
  await withCapturedStderrAsync(async () => {
    await connectChild("thing", {
      command: "node",
      args: [FIXTURE],
      toolAllowlist: ["echo", "nonexistent"],
    });
  }, (captured) => {
    logged = captured;
  });
  try {
    assert.deepEqual(Object.keys(toolMaps.thing), ["echo"]);
    assert.match(logged, /toolAllowlist references unknown tools: nonexistent/);
  } finally {
    disconnectChild("thing");
  }
});

test("connectChild populates resources/prompts when the child supports them", async () => {
  await connectChild("thing", { command: "node", args: [FIXTURE, "--with-resources"] });
  try {
    assert.deepEqual(Object.keys(resourceMaps.thing), ["note://hello"]);
    assert.deepEqual(Object.keys(promptMaps.thing), ["greet"]);
  } finally {
    disconnectChild("thing");
  }
});

test("connectChild does not populate resources/prompts when unsupported", async () => {
  await connectChild("thing", { command: "node", args: [FIXTURE] });
  try {
    assert.equal(resourceMaps.thing, undefined);
    assert.equal(promptMaps.thing, undefined);
  } finally {
    disconnectChild("thing");
  }
});

test("connectChild rejects on connectTimeoutMs when the child never responds", async () => {
  await assert.rejects(
    () =>
      connectChild("thing", {
        command: "node",
        args: [FIXTURE, "--hang-connect"],
        connectTimeoutMs: 200,
      }),
    /timed out/
  );
  assert.equal(clients.thing, undefined);
});

test("a crashed child is automatically reconnected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-proxy-test-"));
  const crashOnceFile = join(dir, "crashed-once");
  await connectChild("thing", {
    command: "node",
    // crash-once-file makes the fixture crash exactly once, so the test
    // observes a single deterministic crash-then-reconnect cycle instead of
    // a repeating crash loop racing against a fixed wait.
    args: [FIXTURE, "--crash-after-ms=100", `--crash-once-file=${crashOnceFile}`],
  });
  try {
    // Wait past the crash (100ms) and the first reconnect attempt (1000ms).
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.ok(clients.thing, "expected the client to be reconnected");
  } finally {
    disconnectChild("thing");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduleReconnect marks a server unavailable after exhausting its retries", () => {
  // Calling with attempt already at the retry limit hits the give-up branch
  // synchronously, so this doesn't need to wait through 1s/4s/9s of real backoff.
  scheduleReconnect("neverWorks", { command: "node", args: ["-e", "process.exit(1)"] }, 3);
  assert.match(unavailableReasons.neverWorks, /failed to reconnect after 3 attempts/);
  assert.equal(clients.neverWorks, undefined);
  delete unavailableReasons.neverWorks;
});

test("disconnectChild cleans up all state and does not trigger a reconnect", async () => {
  await connectChild("thing", { command: "node", args: [FIXTURE] });
  disconnectChild("thing");
  assert.equal(clients.thing, undefined);
  assert.equal(toolMaps.thing, undefined);
  // Give any (incorrectly firing) reconnect logic a chance to run before asserting it didn't.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(clients.thing, undefined);
});
