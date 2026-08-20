import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
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

test("the OpenAI adapter observes a deterministic memory tool call", async () => {
  const result = streamText({
    model: await providerModel(),
    messages: [{ role: "user", content: "[tool-remember] durable fact" }],
    tools: {
      rememberFact: tool({
        inputSchema: z.object({ fact: z.string() }),
      }),
    },
  });
  const calls = [];
  for await (const part of result.fullStream) {
    if (part.type === "tool-call") calls.push(part);
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "rememberFact");
  assert.deepEqual(calls[0].input, { fact: "durable fact" });
});

test("sequential memory calls receive distinct tool call identifiers", async () => {
  const model = await providerModel();
  const callId = async (content) => {
    const result = streamText({
      model,
      messages: [{ role: "user", content }],
      tools: {
        rememberFact: tool({ inputSchema: z.object({ fact: z.string() }) }),
      },
    });
    for await (const part of result.fullStream) {
      if (part.type === "tool-call") return part.toolCallId;
    }
    throw new Error("provider did not emit a tool call");
  };

  const first = await callId("[tool-remember] first");
  const second = await callId("[tool-remember] second");
  assert.notEqual(first, second);
});

test("a deterministic memory tool turn executes once and reaches a final response", async () => {
  let executions = 0;
  const result = streamText({
    model: await providerModel(),
    messages: [{ role: "user", content: "[tool-remember] durable fact" }],
    tools: {
      rememberFact: tool({
        inputSchema: z.object({ fact: z.string() }),
        execute: async ({ fact }) => {
          executions += 1;
          return { fact };
        },
      }),
    },
    stopWhen: stepCountIs(5),
  });

  assert.equal(await result.text, "Deterministic streamed response.");
  assert.equal(executions, 1);
});

test("the OpenAI adapter observes deterministic reminder tool calls", async () => {
  const model = await providerModel();
  const callFor = async (content, tools) => {
    const result = streamText({
      model,
      messages: [{ role: "user", content }],
      tools,
    });
    for await (const part of result.fullStream) {
      if (part.type === "tool-call") return part;
    }
    throw new Error("provider did not emit a reminder tool call");
  };

  const scheduled = await callFor("[tool-reminder-schedule:15] hydrate", {
    scheduleReminder: tool({
      inputSchema: z.object({ message: z.string(), delaySeconds: z.number() }),
    }),
  });
  assert.equal(scheduled.toolName, "scheduleReminder");
  assert.deepEqual(scheduled.input, { message: "hydrate", delaySeconds: 15 });

  const listed = await callFor("[tool-reminder-list]", {
    listReminders: tool({ inputSchema: z.object({}) }),
  });
  assert.equal(listed.toolName, "listReminders");
  assert.deepEqual(listed.input, {});

  const cancelled = await callFor("[tool-reminder-cancel] schedule_123", {
    cancelReminder: tool({ inputSchema: z.object({ id: z.string() }) }),
  });
  assert.equal(cancelled.toolName, "cancelReminder");
  assert.deepEqual(cancelled.input, { id: "schedule_123" });
});

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
