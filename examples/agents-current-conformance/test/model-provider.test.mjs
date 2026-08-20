import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { createDeterministicProvider } from "../scripts/model-provider.mjs";

const MODEL = "llama-swap/Qwen3.6-35B-A3B";
const servers = new Set();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  servers.clear();
});

async function providerModel() {
  const server = createDeterministicProvider();
  servers.add(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const openai = createOpenAI({
    apiKey: "test-placeholder",
    baseURL: `http://127.0.0.1:${address.port}/v1`,
  });
  return openai.chat(MODEL);
}

test("the OpenAI adapter observes multiple deterministic text chunks", async () => {
  const result = streamText({
    model: await providerModel(),
    messages: [{ role: "user", content: "stream" }],
  });
  const chunks = [];
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") chunks.push(part.text);
  }

  assert.deepEqual(chunks, ["Deterministic ", "streamed ", "response."]);
  assert.equal(chunks.join(""), "Deterministic streamed response.");
});

for (const [label, marker] of [
  ["upstream rejection", "[provider-rejected]"],
  ["invalid provider output", "[provider-invalid-output]"],
  ["unreachable provider", "[provider-unavailable]"],
]) {
  test(`the provider deterministically simulates ${label}`, async () => {
    const result = streamText({
      model: await providerModel(),
      maxRetries: 0,
      messages: [{ role: "user", content: marker }],
    });
    const errors = [];
    for await (const part of result.fullStream) {
      if (part.type === "error") errors.push(part.error);
    }
    assert.equal(errors.length, 1);
  });
}
