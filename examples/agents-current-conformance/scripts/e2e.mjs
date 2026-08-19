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

await step("idle eviction and reopen preserve both current Agent states", async () => {
  // celld's idle sweep is timer-driven and a closed public WebSocket may
  // need one extra sweep tick before its host attachment is released.
  await new Promise((resolve) => setTimeout(resolve, (IDLE_EVICT_S + 3) * 1000));
  const [alpha, beta] = await Promise.all([
    json("/agents/current-conformance-agent/alpha/status"),
    json("/agents/current-conformance-agent/beta/status"),
  ]);
  expect(
    alpha.state?.activationCount > baselineState.alpha.activationCount,
    `alpha was not reopened after idle eviction (baseline=${baselineState.alpha.activationCount}, reopened=${alpha.state?.activationCount})`,
  );
  expect(
    beta.state?.activationCount > baselineState.beta.activationCount,
    `beta was not reopened after idle eviction (baseline=${baselineState.beta.activationCount}, reopened=${beta.state?.activationCount})`,
  );
  expect(alpha.state?.messageCount === alphaConversation.received.state.messageCount, "alpha reopen lost current Agent message state");
  expect(beta.state?.value === "current-beta" && beta.state?.revision === 202, "beta reopen lost current Agent state");
  expect(alpha.state?.value === "current-alpha" && alpha.state?.revision === 101, "alpha reopen lost current Agent state");
  expect(alpha.events?.at(-1)?.message === "before-reopen", "alpha reopen lost current Agent SQL event");
});

console.log("PASS current Agents SDK workflow complete");
