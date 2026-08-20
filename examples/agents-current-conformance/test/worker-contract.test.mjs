import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the current target has deterministic named state and durable chat routes", async () => {
  const source = await readFile(join(ROOT, "index.js"), "utf8");
  for (const name of ["alpha", "beta"]) assert.match(source, new RegExp(`\\"${name}\\"`));
  assert.match(source, /initialState/);
  assert.match(source, /activationCount/);
  assert.match(source, /onStart\(\)/);
  assert.match(source, /setState/);
  assert.match(source, /this\.sql/);
  assert.match(source, /current\/names/);
  assert.match(source, /current\/state/);
  assert.match(source, /current-conformance-agent/);
  assert.match(source, /extends AIChatAgent/);
  assert.match(source, /onChatMessage/);
  assert.match(source, /streamText/);
  assert.match(source, /llama-swap\/Qwen3\.6-35B-A3B/);
});
