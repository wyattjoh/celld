#!/usr/bin/env node

const DEFAULT_URL = "http://127.0.0.1:8080";
const REQUEST_TIMEOUT_MS = Number(process.env.CELLD_REQUEST_TIMEOUT_MS ?? 10_000);
const IDLE_EVICT_S = Number(process.env.CELLD_IDLE_EVICT_S ?? 1);

if (!Number.isSafeInteger(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS < 1) {
  throw new Error("CELLD_REQUEST_TIMEOUT_MS must be a positive integer");
}

const baseUrl = new URL(process.env.CELLD_URL ?? DEFAULT_URL);
let baselineState;

if (!Number.isSafeInteger(IDLE_EVICT_S) || IDLE_EVICT_S < 1) {
  throw new Error("CELLD_IDLE_EVICT_S must be a positive integer for the reopen check");
}

function endpoint(path, base = baseUrl) {
  return new URL(path, base).toString();
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint(path), {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} returned HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${init.method ?? "GET"} ${path} exceeded ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function json(path, init = {}) {
  return (await request(path, init)).json();
}

async function post(path, body) {
  return json(path, { method: "POST", body: JSON.stringify(body) });
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

function websocketUrl(name) {
  const url = new URL(`/agents/current-conformance-agent/${name}`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function messageText(message) {
  return message?.parts
    ?.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("") ?? "";
}

async function websocketConversation(name, message) {
  if (typeof WebSocket !== "function") {
    throw new Error("current Node runtime does not expose WebSocket; use Node 22+ for the public WS check");
  }
  const socket = new WebSocket(websocketUrl(name));
  const frames = [];
  const waiters = new Map();
  const onMessage = (event) => {
    if (typeof event.data !== "string") return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    frames.push(frame);
    waiters.get(frame.type)?.(frame);
    waiters.delete(frame.type);
  };
  const nextFrame = (type) => {
    const existing = frames.find((frame) => frame.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      waiters.set(type, resolve);
      socket.addEventListener("error", () => reject(new Error(`WebSocket ${name} failed while waiting for ${type}`)), { once: true });
    });
  };
  socket.addEventListener("message", onMessage);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`WebSocket ${name} failed`)), { once: true });
  });

  const connected = await nextFrame("current-conformance.connected");
  socket.send(JSON.stringify({ message }));
  const received = await nextFrame("current-conformance.message");
  const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
  socket.close();
  await closed;
  socket.removeEventListener("message", onMessage);
  return { connected, received, frames };
}

async function websocketChat(name, text, body = {}) {
  const messages = await json(`/agents/current-conformance-agent/${name}/get-messages`);
  const requestId = `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const userMessage = {
    id: `user-${requestId}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
  const socket = new WebSocket(websocketUrl(name));
  const responseFrames = [];
  let resolveConnected;
  let rejectConnected;
  let resolveDone;
  let rejectDone;
  const connected = new Promise((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const timer = setTimeout(() => {
    rejectConnected(new Error(`WebSocket ${name} chat did not connect`));
    rejectDone(new Error(`WebSocket ${name} chat did not complete`));
    socket.close();
  }, REQUEST_TIMEOUT_MS);
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type === "current-conformance.connected") resolveConnected(frame);
    if (frame.type !== "cf_agent_use_chat_response" || frame.id !== requestId) return;
    responseFrames.push(frame);
    if (frame.done === true) resolveDone(frame);
  });
  socket.addEventListener("error", () => {
    const error = new Error(`WebSocket ${name} chat failed`);
    rejectConnected(error);
    rejectDone(error);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  await connected;
  socket.send(JSON.stringify({
    type: "cf_agent_use_chat_request",
    id: requestId,
    init: {
      method: "POST",
      body: JSON.stringify({
        ...body,
        messages: [...messages, userMessage],
        trigger: "submit-message",
      }),
    },
  }));
  await done;
  clearTimeout(timer);
  const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
  socket.close();
  await closed;
  return { requestId, responseFrames };
}

await step("current target readiness", async () => {
  const result = await json("/current/names");
  expect(result.results?.length === 2, "expected alpha and beta current Agent results");
  expect(result.results.every((entry) => ["alpha", "beta"].includes(entry.agent)), "current Agent names were not isolated");
});

await step("standard current SDK HTTP route", async () => {
  const [alpha, beta] = await Promise.all([
    json("/agents/current-conformance-agent/alpha/status"),
    json("/agents/current-conformance-agent/beta/status"),
  ]);
  expect(alpha.agent === "alpha" && beta.agent === "beta", "current route reached the wrong named Agent");
  baselineState = {
    alpha: alpha.state,
    beta: beta.state,
  };
  expect(Number.isSafeInteger(baselineState.alpha?.messageCount) && Number.isSafeInteger(baselineState.beta?.messageCount), "current Agent state was not deterministic");
});

await step("named state and SQL isolation", async () => {
  await post("/current/state/alpha", { value: "current-alpha", revision: 101 });
  await post("/current/state/beta", { value: "current-beta", revision: 202 });
  const [alpha, beta] = await Promise.all([
    json("/current/state/alpha"),
    json("/current/state/beta"),
  ]);
  expect(alpha.state?.agent === "alpha" && alpha.state?.value === "current-alpha", "alpha state was not retained");
  expect(beta.state?.agent === "beta" && beta.state?.value === "current-beta", "beta state was not retained");
  expect(alpha.records?.length === 1 && alpha.records[0]?.id === "alpha", "alpha SQL leaked rows");
  expect(beta.records?.length === 1 && beta.records[0]?.id === "beta", "beta SQL leaked rows");
});

const alphaConversation = await (async () => {
  let value;
  await step("standard current SDK WebSocket route", async () => {
    value = await websocketConversation("alpha", "before-reopen");
    expect(value.connected.agent === "alpha", "WebSocket connected to the wrong named Agent");
    expect(value.received.state?.messageCount === baselineState.alpha.messageCount + 1 && value.received.state.lastMessage === "before-reopen", "WebSocket message was not durable");
  });
  return value;
})();

let completedTranscript;
await step("AIChatAgent streams and persists a deterministic conversation", async () => {
  const chat = await websocketChat("alpha", "stream a deterministic response");
  const observableChunks = chat.responseFrames.filter((frame) =>
    frame.done !== true && typeof frame.body === "string" && frame.body.length > 0
  );
  expect(observableChunks.length > 1, "expected multiple observable chat streaming events");

  completedTranscript = await json("/agents/current-conformance-agent/alpha/get-messages");
  expect(completedTranscript.at(-2)?.role === "user", "completed transcript did not persist the user message");
  expect(messageText(completedTranscript.at(-2)) === "stream a deterministic response", "persisted user message changed");
  expect(completedTranscript.at(-1)?.role === "assistant", "completed transcript did not persist the assistant message");
  expect(messageText(completedTranscript.at(-1)) === "Deterministic streamed response.", "persisted assistant response was not deterministic");
});

for (const scenario of [
  {
    label: "missing provider capability",
    mode: "missing",
    code: "chat_provider_capability_missing",
    marker: "missing provider capability",
  },
  {
    label: "unreachable provider",
    mode: undefined,
    code: "chat_provider_unavailable",
    marker: "[provider-unavailable]",
  },
  {
    label: "upstream rejection",
    mode: undefined,
    code: "chat_provider_rejected",
    marker: "[provider-rejected]",
  },
  {
    label: "invalid provider output",
    mode: undefined,
    code: "chat_provider_invalid_output",
    marker: "[provider-invalid-output]",
  },
]) {
  await step(`bounded public error for ${scenario.label}`, async () => {
    const chat = await websocketChat(
      "beta",
      scenario.marker,
      scenario.mode === undefined ? {} : { conformanceProviderMode: scenario.mode },
    );
    const publicStream = chat.responseFrames.map((frame) => frame.body ?? "").join("");
    expect(publicStream.includes(scenario.code), `chat stream did not expose ${scenario.code}`);
    expect(!/127\.0\.0\.1|stack|node_modules|rate_limited/i.test(publicStream), "chat error exposed provider or runtime internals");
  });
}

await step("inactivity and reconnect preserve both current Agent states", async () => {
  // Close every public connection, then leave both names idle through several
  // celld load samples before reconnecting through the standard Agent route.
  await new Promise((resolve) => setTimeout(resolve, (IDLE_EVICT_S + 8) * 1000));
  const [alpha, beta] = await Promise.all([
    json("/agents/current-conformance-agent/alpha/status"),
    json("/agents/current-conformance-agent/beta/status"),
  ]);
  expect(alpha.activeConnections === 0 && beta.activeConnections === 0, "closed chat connections remained attached after inactivity");
  expect(
    alpha.state?.activationCount >= baselineState.alpha.activationCount,
    "alpha activation state moved backwards after reconnect",
  );
  expect(
    beta.state?.activationCount >= baselineState.beta.activationCount,
    "beta activation state moved backwards after reconnect",
  );
  expect(alpha.state?.messageCount === alphaConversation.received.state.messageCount, "alpha reopen lost current Agent message state");
  expect(beta.state?.value === "current-beta" && beta.state?.revision === 202, "beta reopen lost current Agent state");
  expect(alpha.state?.value === "current-alpha" && alpha.state?.revision === 101, "alpha reopen lost current Agent state");
  expect(alpha.events?.at(-1)?.message === "before-reopen", "alpha reopen lost current Agent SQL event");

  const reopenedTranscript = await json("/agents/current-conformance-agent/alpha/get-messages");
  expect(
    JSON.stringify(reopenedTranscript) === JSON.stringify(completedTranscript),
    "AIChatAgent transcript changed after inactivity and reopen",
  );
  expect(messageText(reopenedTranscript.at(-1)) === "Deterministic streamed response.", "reopened transcript lost the assistant response");
});

console.log("PASS current Agents SDK and AIChatAgent workflow complete");
