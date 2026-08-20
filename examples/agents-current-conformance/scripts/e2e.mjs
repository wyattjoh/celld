#!/usr/bin/env node

const DEFAULT_URL = "http://127.0.0.1:8080";
const REQUEST_TIMEOUT_MS = Number(process.env.CELLD_REQUEST_TIMEOUT_MS ?? 10_000);
const IDLE_EVICT_S = Number(process.env.CELLD_IDLE_EVICT_S ?? 1);

if (!Number.isSafeInteger(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS < 1) {
  throw new Error("CELLD_REQUEST_TIMEOUT_MS must be a positive integer");
}

const baseUrl = new URL(process.env.CELLD_URL ?? DEFAULT_URL);
const fixtureRunId = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
const fixtureAgents = {
  alpha: `alpha-${fixtureRunId}`,
  beta: `beta-${fixtureRunId}`,
};
const resumeAgents = {
  completed: `resume-completed-${fixtureRunId}`,
  failed: `resume-failed-${fixtureRunId}`,
};
let baselineState;

if (!Number.isSafeInteger(IDLE_EVICT_S) || IDLE_EVICT_S < 1) {
  throw new Error("CELLD_IDLE_EVICT_S must be a positive integer for the reopen check");
}

function fixtureAgentName(name) {
  return fixtureAgents[name] ?? name;
}

function fixturePath(path) {
  return path
    .replace("/agents/current-conformance-agent/alpha", `/agents/current-conformance-agent/${fixtureAgents.alpha}`)
    .replace("/agents/current-conformance-agent/beta", `/agents/current-conformance-agent/${fixtureAgents.beta}`);
}

function endpoint(path, base = baseUrl) {
  return new URL(fixturePath(path), base).toString();
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
  const url = new URL(`/agents/current-conformance-agent/${fixtureAgentName(name)}`, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function messageText(message) {
  return message?.parts
    ?.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("") ?? "";
}

function toolParts(messages, name) {
  return messages
    .flatMap((message) => message?.parts ?? [])
    .filter((part) => part?.type === `tool-${name}` ||
      (part?.type === "dynamic-tool" && part.toolName === name));
}

function lastToolPart(messages, name) {
  return toolParts(messages, name).at(-1);
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

async function clearChat(name) {
  const socket = new WebSocket(websocketUrl(name));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error(`WebSocket ${name} failed while clearing chat`)), { once: true });
  });
  socket.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
  socket.close();
  await Promise.race([
    closed,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  const messages = await json(`/agents/current-conformance-agent/${name}/get-messages`);
  expect(messages.length === 0, `${name} chat clear did not make the run repeatable`);
}

async function observeState(name, predicate, action) {
  const socket = new WebSocket(websocketUrl(name));
  let resolveConnected;
  let rejectConnected;
  let resolveState;
  let rejectState;
  const connected = new Promise((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const observed = new Promise((resolve, reject) => {
    resolveState = resolve;
    rejectState = reject;
  });
  const timer = setTimeout(() => {
    const error = new Error(`WebSocket ${name} did not broadcast the expected Agent state`);
    rejectConnected(error);
    rejectState(error);
    socket.close();
  }, REQUEST_TIMEOUT_MS);
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type === "current-conformance.connected") resolveConnected();
    if (frame.type === "cf_agent_state" && predicate(frame.state)) resolveState(frame.state);
  });
  socket.addEventListener("error", () => {
    const error = new Error(`WebSocket ${name} state observer failed`);
    rejectConnected(error);
    rejectState(error);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  await connected;
  try {
    await action();
    return await observed;
  } finally {
    clearTimeout(timer);
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
    socket.close();
    await closed;
  }
}

async function openChatSocket(name) {
  const socket = new WebSocket(websocketUrl(name));
  let resolveConnected;
  let rejectConnected;
  const connected = new Promise((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const timer = setTimeout(() => {
    rejectConnected(new Error(`WebSocket ${name} did not identify the Agent`));
    socket.close();
  }, REQUEST_TIMEOUT_MS);
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      if (JSON.parse(event.data).type === "current-conformance.connected") {
        resolveConnected();
      }
    } catch {
      // Ignore non-JSON Agent frames.
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  await connected;
  clearTimeout(timer);
  return socket;
}

async function closeChatSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  let rejectTimeout;
  const closed = new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
  const timedOut = new Promise((_, reject) => {
    rejectTimeout = setTimeout(
      () => reject(new Error("WebSocket did not close after its response completed")),
      REQUEST_TIMEOUT_MS,
    );
  });
  if (socket.readyState !== WebSocket.CLOSING) socket.close();
  try {
    await Promise.race([closed, timedOut]);
  } finally {
    clearTimeout(rejectTimeout);
  }
}

function responseChunk(frame) {
  if (typeof frame?.body !== "string" || frame.body.length === 0) return null;
  try {
    return JSON.parse(frame.body);
  } catch {
    return null;
  }
}

function responseText(frames) {
  return frames
    .map(responseChunk)
    .filter((chunk) => chunk?.type === "text-delta" && typeof chunk.delta === "string")
    .map((chunk) => chunk.delta)
    .join("");
}

async function startInterruptedChat(name, text) {
  const messages = await json(`/agents/current-conformance-agent/${name}/get-messages`);
  const requestId = `interrupted-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const socket = await openChatSocket(name);
  const responseFrames = [];
  let resolveFirstChunk;
  let rejectFirstChunk;
  const firstChunk = new Promise((resolve, reject) => {
    resolveFirstChunk = resolve;
    rejectFirstChunk = reject;
  });
  const timer = setTimeout(() => {
    rejectFirstChunk(new Error(`WebSocket ${name} did not receive an interruptible chunk`));
    socket.close();
  }, REQUEST_TIMEOUT_MS);
  const onMessage = (event) => {
    if (typeof event.data !== "string") return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type !== "cf_agent_use_chat_response" || frame.id !== requestId) return;
    responseFrames.push(frame);
    if (responseChunk(frame)?.type === "text-delta") resolveFirstChunk();
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", () => {
    rejectFirstChunk(new Error(`WebSocket ${name} interrupted chat failed`));
  }, { once: true });
  socket.send(JSON.stringify({
    type: "cf_agent_use_chat_request",
    id: requestId,
    init: {
      method: "POST",
      body: JSON.stringify({
        messages: [
          ...messages,
          {
            id: `user-${requestId}`,
            role: "user",
            parts: [{ type: "text", text }],
          },
        ],
        trigger: "submit-message",
      }),
    },
  }));
  await firstChunk;
  clearTimeout(timer);
  socket.removeEventListener("message", onMessage);
  socket.close();
  return { requestId, responseFrames };
}

async function resumeInterruptedChat(name, requestId, staleRequestId = undefined) {
  const socket = await openChatSocket(name);
  const responseFrames = [];
  const probeId = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let acknowledged = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const timer = setTimeout(() => {
    rejectDone(new Error(`WebSocket ${name} did not resume ${requestId}`));
    socket.close();
  }, REQUEST_TIMEOUT_MS);
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type === "cf_agent_stream_resume_none" &&
        (frame.probeId === undefined || frame.probeId === probeId)) {
      rejectDone(new Error(`WebSocket ${name} reported no resumable stream`));
      return;
    }
    if (frame.type === "cf_agent_stream_resuming" && frame.id === requestId && !acknowledged) {
      acknowledged = true;
      socket.send(JSON.stringify({ type: "cf_agent_stream_resume_ack", id: requestId }));
      return;
    }
    if (frame.type !== "cf_agent_use_chat_response" || frame.id !== requestId) return;
    responseFrames.push(frame);
    if (frame.done === true) resolveDone();
  });
  socket.addEventListener("error", () => {
    rejectDone(new Error(`WebSocket ${name} resume failed`));
  }, { once: true });
  if (staleRequestId !== undefined) {
    socket.send(JSON.stringify({ type: "cf_agent_stream_resume_ack", id: staleRequestId }));
  }
  socket.send(JSON.stringify({ type: "cf_agent_stream_resume_request", probeId }));
  await done;
  clearTimeout(timer);
  await closeChatSocket(socket);
  return responseFrames;
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
  await closeChatSocket(socket);
  return { requestId, responseFrames };
}

await step("current target readiness", async () => {
  const result = await json("/current/names");
  expect(result.results?.length === 2, "expected alpha and beta current Agent results");
  expect(result.results.every((entry) => ["alpha", "beta"].includes(entry.agent)), "current Agent names were not isolated");
  const reset = await post("/current/memories/reset", {});
  expect(reset.results?.every((entry) => entry.total === 0), "memory reset did not make the run repeatable");
  const reminderReset = await post("/current/reminders/reset", {});
  expect(reminderReset.results?.every((entry) => entry.total === 0), "reminder reset did not make the run repeatable");
  await Promise.all([clearChat("alpha"), clearChat("beta")]);
});

await step("standard current SDK HTTP route", async () => {
  const [alpha, beta] = await Promise.all([
    json("/agents/current-conformance-agent/alpha/status"),
    json("/agents/current-conformance-agent/beta/status"),
  ]);
  expect(
    alpha.agent === fixtureAgents.alpha && beta.agent === fixtureAgents.beta,
    "current route reached the wrong named Agent",
  );
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
    expect(value.connected.agent === fixtureAgents.alpha, "WebSocket connected to the wrong named Agent");
    expect(value.received.state?.messageCount === baselineState.alpha.messageCount + 1 && value.received.state.lastMessage === "before-reopen", "WebSocket message was not durable");
  });
  return value;
})();

await step("AIChatAgent streams and persists a deterministic conversation", async () => {
  const chat = await websocketChat("alpha", "stream a deterministic response");
  const observableChunks = chat.responseFrames.filter((frame) =>
    frame.done !== true && typeof frame.body === "string" && frame.body.length > 0
  );
  expect(observableChunks.length > 1, "expected multiple observable chat streaming events");

  const transcript = await json("/agents/current-conformance-agent/alpha/get-messages");
  expect(transcript.at(-2)?.role === "user", "completed transcript did not persist the user message");
  expect(messageText(transcript.at(-2)) === "stream a deterministic response", "persisted user message changed");
  expect(transcript.at(-1)?.role === "assistant", "completed transcript did not persist the assistant message");
  expect(messageText(transcript.at(-1)) === "Deterministic streamed response.", "persisted assistant response was not deterministic");
});

await step("interrupted chat replays once to concurrent resumptions and persists one assistant", async () => {
  const name = resumeAgents.completed;
  const before = await json(`/agents/current-conformance-agent/${name}/get-messages`);
  const interrupted = await startInterruptedChat(name, "[provider-paused]");
  expect(
    responseText(interrupted.responseFrames) === "Interrupted ",
    `disconnect did not occur after the first known chunk: ${JSON.stringify(interrupted.responseFrames.map(responseChunk))}`,
  );

  const [firstResume, duplicateResume] = await Promise.all([
    resumeInterruptedChat(name, interrupted.requestId),
    resumeInterruptedChat(name, interrupted.requestId, `stale-${interrupted.requestId}`),
  ]);
  expect(responseText(firstResume) === "Interrupted stream completed.", "first resumer did not reconcile the complete response");
  expect(responseText(duplicateResume) === "Interrupted stream completed.", "duplicate resumer observed missing or duplicated content");

  const transcript = await json(`/agents/current-conformance-agent/${name}/get-messages`);
  const appended = transcript.slice(before.length);
  expect(appended.length === 2, "interrupted response persisted more than one logical turn");
  expect(appended[0]?.role === "user" && messageText(appended[0]) === "[provider-paused]", "interrupted user message was not durable");
  expect(appended[1]?.role === "assistant", "interrupted response did not persist one assistant message");
  expect(messageText(appended[1]) === "Interrupted stream completed.", "persisted interrupted response was incomplete");
  expect(appended[1]?.metadata?.celldStream?.status === "completed", "completed interrupted response had no durable terminal outcome");
});

await step("terminal provider failure reconciles into a bounded durable outcome", async () => {
  const name = resumeAgents.failed;
  const before = await json(`/agents/current-conformance-agent/${name}/get-messages`);
  const interrupted = await startInterruptedChat(name, "[provider-terminal-failure]");
  expect(responseText(interrupted.responseFrames) === "Interrupted ", "failure scenario did not emit its known partial chunk");
  await new Promise((resolve) => setTimeout(resolve, 900));

  const resumed = await resumeInterruptedChat(name, interrupted.requestId);
  const publicStream = resumed.map((frame) => frame.body ?? "").join("");
  expect(responseText(resumed) === "Interrupted ", "resumed failure lost or duplicated its durable partial text");
  expect(resumed.some((frame) => frame.done === true), "resumed failure did not terminate the resumable response");
  expect(!/127\.0\.0\.1|stack|node_modules|UND_ERR/i.test(publicStream), "resumed failure exposed provider or runtime internals");

  const transcript = await json(`/agents/current-conformance-agent/${name}/get-messages`);
  const appended = transcript.slice(before.length);
  expect(appended.length === 2, "failed interrupted response persisted more than one logical turn");
  expect(appended[1]?.role === "assistant", "failed interrupted response omitted its assistant message");
  expect(messageText(appended[1]) === "Interrupted ", "failed interrupted response lost its durable partial content");
  expect(
    appended[1]?.parts?.every((part) => part?.state !== "streaming"),
    "failed interrupted response remained permanently streaming",
  );
  expect(appended[1]?.metadata?.celldStream?.status === "failed", "failed response omitted its durable terminal status");
  expect(appended[1]?.metadata?.celldStream?.code === "chat_provider_unavailable", "failed response persisted an unstable error");
});

const durableFact = "alpha durable memory";
let memoryTranscript;
await step("schema-validated tools persist explicit memory outside chat messages", async () => {
  await websocketChat("alpha", `[tool-remember] ${durableFact}`);
  memoryTranscript = await json("/agents/current-conformance-agent/alpha/get-messages");
  const toolPart = lastToolPart(memoryTranscript, "rememberFact");
  expect(toolPart?.state === "output-available", "rememberFact did not persist a completed tool result");
  expect(toolPart.output?.memory?.fact === durableFact, "rememberFact returned the wrong durable fact");

  const [alpha, beta] = await Promise.all([
    json("/agents/current-conformance-agent/alpha/status"),
    json("/agents/current-conformance-agent/beta/status"),
  ]);
  expect(alpha.memories?.length === 1 && alpha.memories[0]?.fact === durableFact, "alpha status did not expose its explicit memory");
  expect(beta.memories?.length === 0, "alpha memory leaked into beta");
});

await step("list and summary tools remain bounded to the named Agent", async () => {
  await websocketChat("alpha", "[tool-list]");
  const alphaMessages = await json("/agents/current-conformance-agent/alpha/get-messages");
  const listPart = lastToolPart(alphaMessages, "listMemories");
  expect(listPart?.output?.total === 1, "listMemories returned the wrong bounded count");
  expect(listPart.output.memories?.[0]?.fact === durableFact, "listMemories omitted alpha's fact");

  await websocketChat("beta", "[tool-summarize]");
  const betaMessages = await json("/agents/current-conformance-agent/beta/get-messages");
  const summaryPart = lastToolPart(betaMessages, "summarizeMemories");
  expect(summaryPart?.output?.memories === 0, "beta summary observed another Agent's memory");
  expect(summaryPart.output.summary === "Nothing has been remembered yet.", "empty summary was not deterministic");
});

for (const [label, marker] of [
  ["empty", "[tool-empty]"],
  ["oversized", `[tool-remember] ${"x".repeat(501)}`],
  ["malformed cross-Agent", "[tool-malformed]"],
]) {
  await step(`${label} memory tool input cannot write durable state`, async () => {
    await websocketChat("alpha", marker);
    const transcript = await json("/agents/current-conformance-agent/alpha/get-messages");
    const failedPart = lastToolPart(transcript, "rememberFact");
    expect(failedPart?.state === "output-error", `${label} input did not persist a failed tool part`);
    expect(failedPart.errorText === "chat_provider_invalid_output", `${label} input exposed an unstable tool error`);
    const alpha = await json("/agents/current-conformance-agent/alpha/status");
    expect(alpha.memories?.length === 1 && alpha.memories[0]?.fact === durableFact, `${label} input changed alpha memory`);
    const beta = await json("/agents/current-conformance-agent/beta/status");
    expect(beta.memories?.length === 0, `${label} input wrote across Agent names`);
  });
}

await step("memory count and summary inputs remain bounded", async () => {
  const boundaryFacts = [
    "y".repeat(500),
    ...Array.from({ length: 18 }, (_, index) => `bounded-memory-${index + 2}`),
  ];
  for (const fact of boundaryFacts) {
    await websocketChat("alpha", `[tool-remember] ${fact}`);
  }
  let alpha = await json("/agents/current-conformance-agent/alpha/status");
  expect(alpha.memories?.length === 20, "the memory cap did not accept exactly 20 facts");
  expect(alpha.memories.some((memory) => memory.fact.length === 500), "the fact-length boundary was not retained");

  await websocketChat("alpha", "[tool-remember] over-capacity-memory");
  alpha = await json("/agents/current-conformance-agent/alpha/status");
  expect(alpha.memories?.length === 20, "the memory cap accepted a 21st fact");

  await websocketChat("alpha", "[tool-summarize]");
  const transcript = await json("/agents/current-conformance-agent/alpha/get-messages");
  const summary = lastToolPart(transcript, "summarizeMemories");
  expect(summary?.output?.memories === 10, "summary did not use the bounded 10-memory window");
  expect(!summary.output.summary.includes(durableFact), "summary included facts outside its bounded window");
});

for (const [label, marker] of [
  ["zero delay", "[tool-reminder-schedule:0] invalid delay"],
  ["excessive delay", "[tool-reminder-schedule:3601] invalid delay"],
  ["empty message", "[tool-reminder-schedule:10]"],
  ["oversized message", `[tool-reminder-schedule:10] ${"r".repeat(501)}`],
]) {
  await step(`${label} reminder input cannot create a schedule`, async () => {
    const chat = await websocketChat("alpha", marker);
    const transcript = await json("/agents/current-conformance-agent/alpha/get-messages");
    const failedPart = lastToolPart(transcript, "scheduleReminder");
    const publicStream = chat.responseFrames.map((frame) => frame.body ?? "").join("");
    expect(
      failedPart?.state === "output-error" || publicStream.includes("chat_provider_invalid_output"),
      `${label} did not expose a bounded reminder validation failure`,
    );
    const alpha = await json("/agents/current-conformance-agent/alpha/status");
    expect(alpha.reminders?.length === 0, `${label} created reminder metadata`);
  });
}

let cancellableReminderId;
await step("reminder scheduling is idempotent and listable", async () => {
  const marker = "[tool-reminder-schedule:30] deterministic cancellable reminder";
  await websocketChat("alpha", marker);
  let transcript = await json("/agents/current-conformance-agent/alpha/get-messages");
  const first = lastToolPart(transcript, "scheduleReminder");
  expect(first?.state === "output-available", "scheduleReminder did not complete");
  expect(first.output?.reminder?.status === "pending", "new reminder was not pending");
  cancellableReminderId = first.output.reminder.id;

  await websocketChat("alpha", marker);
  transcript = await json("/agents/current-conformance-agent/alpha/get-messages");
  const repeated = lastToolPart(transcript, "scheduleReminder");
  expect(repeated?.output?.duplicate === true, "repeated schedule call did not report deduplication");
  expect(repeated.output.reminder?.id === cancellableReminderId, "repeated schedule call changed identifiers");

  await websocketChat("alpha", "[tool-reminder-list]");
  transcript = await json("/agents/current-conformance-agent/alpha/get-messages");
  const listed = lastToolPart(transcript, "listReminders");
  expect(listed?.output?.pending === 1, "listReminders did not expose exactly one pending reminder");
  expect(listed.output.reminders?.[0]?.id === cancellableReminderId, "listReminders omitted the pending reminder");
});

await step("cross-Agent and malformed cancellation attempts are rejected", async () => {
  await websocketChat("beta", `[tool-reminder-cancel] ${cancellableReminderId}`);
  let transcript = await json("/agents/current-conformance-agent/beta/get-messages");
  const crossAgent = lastToolPart(transcript, "cancelReminder");
  expect(crossAgent?.state === "output-error", "cross-Agent cancellation did not fail");

  await websocketChat("alpha", "[tool-reminder-cancel] invalid/id");
  transcript = await json("/agents/current-conformance-agent/alpha/get-messages");
  const malformed = lastToolPart(transcript, "cancelReminder");
  expect(malformed?.state === "output-error", "malformed schedule id did not fail");

  const alpha = await json("/agents/current-conformance-agent/alpha/status");
  expect(
    alpha.reminders?.some((reminder) =>
      reminder.id === cancellableReminderId && reminder.status === "pending"),
    "rejected cancellation changed the owning Agent reminder",
  );
  const beta = await json("/agents/current-conformance-agent/beta/status");
  expect(beta.reminders?.length === 0, "cross-Agent cancellation created beta reminder state");
});

await step("the owning Agent can cancel and retain reminder history", async () => {
  await websocketChat("alpha", `[tool-reminder-cancel] ${cancellableReminderId}`);
  const transcript = await json("/agents/current-conformance-agent/alpha/get-messages");
  const cancelled = lastToolPart(transcript, "cancelReminder");
  expect(cancelled?.output?.cancelled === true, "cancelReminder did not report cancellation");
  expect(cancelled.output.reminder?.status === "cancelled", "cancelled reminder metadata was not durable");
  const alpha = await json("/agents/current-conformance-agent/alpha/status");
  expect(
    alpha.reminders?.some((reminder) =>
      reminder.id === cancellableReminderId && reminder.status === "cancelled"),
    "status did not retain the cancelled reminder",
  );
});

await step("completed reminder state broadcasts without polling", async () => {
  const message = "broadcast reminder completion";
  const state = await observeState(
    "alpha",
    (candidate) => candidate?.reminderItems?.some((reminder) =>
      reminder.message === message && reminder.status === "completed"),
    async () => websocketChat("alpha", `[tool-reminder-schedule:2] ${message}`),
  );
  expect(state.lastReminder === message, "broadcast state omitted the completed reminder");
});

await step("an alarm wakes an inactive Agent and preserves Agent isolation", async () => {
  const delaySeconds = IDLE_EVICT_S + 8;
  const message = "inactive beta reminder";
  await websocketChat("beta", `[tool-reminder-schedule:${delaySeconds}] ${message}`);
  await new Promise((resolve) => setTimeout(resolve, (delaySeconds + 2) * 1_000));
  const [alpha, beta] = await Promise.all([
    json("/agents/current-conformance-agent/alpha/status"),
    json("/agents/current-conformance-agent/beta/status"),
  ]);
  expect(beta.activeConnections === 0, "beta retained a public connection through the alarm wait");
  expect(
    beta.reminders?.some((reminder) =>
      reminder.message === message && reminder.status === "completed"),
    "inactive beta reminder did not complete durably",
  );
  expect(
    !alpha.reminders?.some((reminder) => reminder.message === message),
    "beta reminder leaked into alpha",
  );
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

const reconnectMarker = "[tool-reminder-list]";
await step("latest reminder transcript is durable before inactivity", async () => {
  await websocketChat("alpha", reconnectMarker);
});

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
  expect(alpha.events?.at(-1)?.message === "before-reopen", "alpha reopen lost current Agent SQL event");

  const reopenedTranscript = await json("/agents/current-conformance-agent/alpha/get-messages");
  expect(
    reopenedTranscript.some((message) =>
      message.role === "user" && messageText(message) === reconnectMarker),
    "AIChatAgent transcript lost the latest user message after inactivity and reopen",
  );
  expect(
    toolParts(reopenedTranscript, "listReminders")
      .some((part) => part?.output?.reminders?.some((reminder) =>
        reminder.id === cancellableReminderId && reminder.status === "cancelled")),
    "reopened transcript lost the latest durable reminder tool result",
  );
  expect(alpha.memories?.[0]?.fact === durableFact, "reopened Agent lost explicit memory state");
});

console.log("PASS current Agents SDK and AIChatAgent workflow complete");
