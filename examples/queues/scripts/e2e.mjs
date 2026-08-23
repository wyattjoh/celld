#!/usr/bin/env node

const DEFAULT_URL = "http://127.0.0.1:8080";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const DROP_QUIET_WINDOW_MS = 5_000;

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const baseUrl = new URL(process.env.CELLD_URL ?? DEFAULT_URL);
if (baseUrl.username || baseUrl.password) {
  throw new Error("CELLD_URL must not include credentials");
}
const requestTimeoutMs = positiveInteger(
  "CELLD_REQUEST_TIMEOUT_MS",
  DEFAULT_REQUEST_TIMEOUT_MS,
);
const readinessTimeoutMs = positiveInteger(
  "CELLD_READINESS_TIMEOUT_MS",
  DEFAULT_READINESS_TIMEOUT_MS,
);

function endpoint(path) {
  return new URL(path, baseUrl).toString();
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(endpoint(path), {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(
        `${init.method ?? "GET"} ${path} returned HTTP ${response.status}` +
          (detail ? `: ${detail}` : ""),
      );
    }
    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${init.method ?? "GET"} ${path} exceeded ${requestTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function json(path, init = {}) {
  const response = await request(path, init);
  return response.json();
}

async function post(path, body) {
  return json(path, { method: "POST", body: JSON.stringify(body) });
}

async function records() {
  return (await json("/deliveries")).records;
}

async function reset() {
  await request("/reset", { method: "POST" });
}

async function eventually(name, predicate) {
  const deadline = Date.now() + readinessTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(`${name} did not complete within ${readinessTimeoutMs}ms${detail}`);
}

async function step(name, action) {
  try {
    await action();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

await step("celld readiness", async () => {
  await eventually("celld readiness", async () => Array.isArray(await records()));
});

await step("send and sendBatch deliver and acknowledge each content type", async () => {
  await reset();
  await post("/send", {
    body: { mode: "ack", label: "json-message", value: 42 },
    options: { contentType: "json" },
  });
  await post("/send-batch", {
    messages: [
      { body: "text-message", contentType: "text" },
      { body: [1, 2, 3, 255], contentType: "bytes" },
    ],
  });

  const delivered = await eventually("send/sendBatch deliveries", async () => {
    const current = await records();
    return current.length === 3 ? current : false;
  });
  const jsonMessage = delivered.find((entry) => entry.body?.label === "json-message");
  const textMessage = delivered.find((entry) => entry.body === "text-message");
  const bytesMessage = delivered.find((entry) => entry.contentType === "bytes");
  expect(jsonMessage?.contentType === "json" && jsonMessage.body.value === 42,
    "send() did not preserve the JSON body/contentType");
  expect(textMessage?.contentType === "text",
    "sendBatch() did not preserve the text body/contentType");
  expect(JSON.stringify(bytesMessage?.body) === JSON.stringify([1, 2, 3, 255]),
    "sendBatch() did not preserve the bytes body/contentType");
  expect(delivered.every((entry) => entry.attempt === 1),
    "acknowledged messages were unexpectedly redelivered");
});

await step("retry redelivers only the selected message", async () => {
  await reset();
  await post("/send-batch", {
    messages: [
      { body: { mode: "ack", label: "sibling-before" }, contentType: "json" },
      { body: { mode: "retry", until: 2, label: "retry-me" }, contentType: "json" },
      { body: { mode: "ack", label: "sibling-after" }, contentType: "json" },
    ],
  });

  const delivered = await eventually("selective retry", async () => {
    const current = await records();
    const retried = current.filter((entry) => entry.body?.label === "retry-me");
    const siblings = current.filter((entry) => entry.body?.label?.startsWith("sibling-"));
    return retried.length === 2 && siblings.length === 2 ? current : false;
  });
  const retried = delivered.filter((entry) => entry.body?.label === "retry-me");
  const siblings = delivered.filter((entry) => entry.body?.label?.startsWith("sibling-"));
  expect(new Set(retried.map((entry) => entry.id)).size === 1,
    "retry created a new message identity");
  expect(JSON.stringify(retried.map((entry) => entry.attempt)) === "[1,2]",
    "retry did not produce exactly the first and second attempts");
  expect(siblings.every((entry) => entry.attempt === 1),
    "an acknowledged sibling was redelivered");
});

await step("poison message drops after three attempts and the backlog drains", async () => {
  await reset();
  await post("/send-batch", {
    messages: [
      { body: { mode: "poison", label: "poison" }, contentType: "json" },
      { body: { mode: "ack", label: "after-poison" }, contentType: "json" },
    ],
  });

  const settled = await eventually("poison drop", async () => {
    const current = await records();
    const poison = current.filter((entry) => entry.body?.label === "poison");
    const sentinel = current.filter((entry) => entry.body?.label === "after-poison");
    return poison.length === 3 && sentinel.length === 1 ? current : false;
  });
  const poison = settled.filter((entry) => entry.body?.label === "poison");
  const sentinel = settled.filter((entry) => entry.body?.label === "after-poison");
  expect(new Set(poison.map((entry) => entry.id)).size === 1,
    "poison retries changed message identity");
  expect(JSON.stringify(poison.map((entry) => entry.attempt)) === "[1,2,3]",
    "poison message did not reach the configured retry ceiling");
  expect(sentinel[0]?.attempt === 1,
    "the acknowledged sentinel did not drain behind the poison message");

  await sleep(DROP_QUIET_WINDOW_MS);
  const afterQuietWindow = await records();
  expect(afterQuietWindow.length === settled.length,
    "delivery count changed after the poison message should have been dropped");
});

console.log("PASS queues E2E workflow complete");
