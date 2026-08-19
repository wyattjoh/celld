#!/usr/bin/env node

const DEFAULT_URL = "http://127.0.0.1:8080";
const DEFAULT_INTERNAL_URL = "http://127.0.0.1:8081";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;

function timeoutFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function baseUrlFromEnv() {
  const url = new URL(process.env.CELLD_URL ?? DEFAULT_URL);
  if (url.username || url.password) {
    throw new Error("CELLD_URL must not include credentials");
  }
  return url;
}

const baseUrl = baseUrlFromEnv();
const internalUrl = new URL(process.env.CELLD_INTERNAL_URL ?? DEFAULT_INTERNAL_URL);
if (internalUrl.username || internalUrl.password) {
  throw new Error("CELLD_INTERNAL_URL must not include credentials");
}
const requestTimeoutMs = timeoutFromEnv(
  "CELLD_REQUEST_TIMEOUT_MS",
  DEFAULT_REQUEST_TIMEOUT_MS,
);
const readinessTimeoutMs = timeoutFromEnv(
  "CELLD_READINESS_TIMEOUT_MS",
  DEFAULT_READINESS_TIMEOUT_MS,
);

function endpoint(path, base = baseUrl) {
  return new URL(path, base).toString();
}

function fail(message) {
  throw new Error(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

async function requestStatus(path, init = {}, base = baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    return await fetch(endpoint(path, base), {
      ...init,
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      fail(`${init.method ?? "GET"} ${path} exceeded ${requestTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function request(path, init = {}, base = baseUrl) {
  const response = await requestStatus(path, init, base);
  if (!response.ok) {
    fail(`${init.method ?? "GET"} ${path} returned HTTP ${response.status}`);
  }
  return response;
}

async function json(path, init = {}, base = baseUrl) {
  const response = await request(path, init, base);
  try {
    return await response.json();
  } catch {
    fail(`${init.method ?? "GET"} ${path} returned invalid JSON`);
  }
}

async function jsonStatus(path, init = {}, base = baseUrl) {
  const response = await requestStatus(path, init, base);
  let body;
  try {
    body = await response.json();
  } catch {
    fail(`${init.method ?? "GET"} ${path} returned invalid JSON`);
  }
  return { status: response.status, body };
}

async function post(path, body, base = baseUrl) {
  return json(path, { method: "POST", body: JSON.stringify(body) }, base);
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

async function waitForReadiness() {
  const deadline = Date.now() + readinessTimeoutMs;
  let lastError = "not yet reachable";
  while (Date.now() < deadline) {
    try {
      const result = await json("/conformance/names");
      expect(Array.isArray(result.results), "readiness response lacks results");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fail(`celld did not become ready within ${readinessTimeoutMs}ms (${lastError})`);
}

async function eventually(name, predicate) {
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`${name} did not complete within ${readinessTimeoutMs}ms`);
}

await step("celld readiness", waitForReadiness);

await step("two named Agents and route request", async () => {
  const names = await json("/conformance/names");
  expect(names.results?.length === 2, "expected exactly two named Agent results");
  expect(names.results.every((entry) => ["alpha", "beta"].includes(entry.agent)),
    "named Agent results did not identify alpha and beta");
  const alpha = await json("/conformance/call/alpha");
  const beta = await json("/conformance/call/beta");
  expect(alpha.agent === "alpha" && beta.agent === "beta", "named Agent calls were not isolated");
});

await step("Agent state and SQL isolation", async () => {
  await post("/conformance/state/alpha", { value: "e2e-alpha", revision: 101 });
  await post("/conformance/state/beta", { value: "e2e-beta", revision: 202 });
  const [alpha, beta] = await Promise.all([
    json("/conformance/state/alpha"),
    json("/conformance/state/beta"),
  ]);
  expect(alpha.state?.value === "e2e-alpha" && beta.state?.value === "e2e-beta",
    "Agent state values were not retained independently");
  expect(alpha.sql?.length === 1 && alpha.sql[0]?.id === "alpha", "alpha SQL leaked rows");
  expect(beta.sql?.length === 1 && beta.sql[0]?.id === "beta", "beta SQL leaked rows");
});

await step("Workspace lifecycle", async () => {
  const path = "/e2e-runner-workspace.txt";
  await post("/conformance/workspace/alpha", { operation: "delete", path, force: true });
  await post("/conformance/workspace/alpha", { operation: "create", path, content: "created\n" });
  expect((await post("/conformance/workspace/alpha", { operation: "read", path })).content === "created\n",
    "Workspace create/read mismatch");
  await post("/conformance/workspace/alpha", { operation: "update", path, content: "updated e2e\n" });
  const listed = await post("/conformance/workspace/alpha", { operation: "list", path: "/" });
  expect(listed.files?.includes(path), "Workspace list omitted created file");
  const searched = await post("/conformance/workspace/alpha", {
    operation: "search", path: "/", query: "UPDATED", ignoreCase: true,
  });
  expect(searched.hits?.some((hit) => hit.path === path), "Workspace search omitted updated file");
  await post("/conformance/workspace/alpha", { operation: "delete", path });
});

await step("Worker Shell", async () => {
  const path = "/e2e-runner/shell.txt";
  const shell = await post("/conformance/shell/alpha", {
    command: `mkdir -p /e2e-runner && printf "shell e2e\\n" > ${path} && cat ${path}`,
  });
  expect(shell.outcome === "completed" && shell.stdout === "shell e2e\n", "Worker Shell did not complete");
  const workspace = await post("/conformance/workspace/alpha", { operation: "read", path });
  expect(workspace.content === "shell e2e\n", "Worker Shell write was not visible to Workspace");
  const timeout = await post("/conformance/shell/alpha", { command: "sleep 5", timeoutMs: 1 });
  expect(timeout.outcome === "timed_out" && timeout.exitCode === 124, "Worker Shell timeout was not bounded");
});

await step("Worker JavaScript loader modules and cancellation", async () => {
  const run = await post("/conformance/javascript/alpha", { input: { value: 7 } });
  expect(run.status === "completed" && run.value?.suffix === ":sibling" && run.value?.content === "workspace\n",
    "Worker JavaScript default module failed");
  const modules = await post("/conformance/javascript/alpha", { operation: "loader-modules", input: { value: 40 } });
  expect(modules.value?.label === ":loader-sibling" && modules.value?.sum === 42,
    "Worker JavaScript loader modules failed");
  const cancelled = await post("/conformance/javascript/alpha", { operation: "cancel" });
  expect(cancelled.status === "cancelled" && cancelled.exitCode === 130,
    "Worker JavaScript cancellation was not bounded");
});

await step("Code Mode capability lifecycle and eviction", async () => {
  const disposed = await post("/conformance/code-mode/alpha", {
    operation: "disposed",
    value: "lifecycle",
  });
  expect(disposed.disposed && disposed.before?.value === "lifecycle",
    "capability lifecycle probe did not complete before disposal");
  expect(disposed.error?.code === "code_mode.host_lost" ||
    disposed.error?.code === "code_mode.disposed",
    "disposed capability did not return a stable Code Mode code");
  expect(typeof disposed.error?.retryable === "boolean",
    "disposed capability omitted retryable metadata");

  const mutation = await post("/conformance/code-mode/alpha", {
    operation: "mutation",
    value: "durable-before-disposal",
    delayMs: 25,
  });
  expect(mutation.value?.mutation?.agent === "alpha" &&
    mutation.mutations?.[0]?.value === "durable-before-disposal",
    "acknowledged capability mutation was not observable after disposal");

  const eviction = await post("/conformance/code-mode/alpha", {
    operation: "eviction-prepare",
  });
  expect(typeof eviction.scope === "string" && eviction.scope.length > 0,
    "eviction probe did not expose its resident cell scope");
  await request(`/evict/ConformanceAgent:${eviction.scope}`, { method: "POST" }, internalUrl);
  const stale = await post("/conformance/code-mode/alpha", {
    operation: "eviction-stale",
  });
  expect(stale.error?.code === "code_mode.host_lost" ||
    stale.error?.code === "code_mode.disposed",
    "an evicted Agent's stale loader handle was not rejected");
  expect(/worker_disposed|host_lost|disposed/i.test(stale.error?.message ?? ""),
    "stale loader failure omitted its interruption class");
});

await step("Code Mode egress, tools, and bounded output", async () => {
  const egress = await post("/conformance/code-mode/alpha", {
    operation: "egress",
    url: "https://approved.example/api/v1",
  });
  expect(egress.value?.status === 200 &&
    egress.value?.body === "approved:https://approved.example/api/v1",
    "allowlisted Code Mode egress did not succeed");
  const denied = await post("/conformance/code-mode/alpha", {
    operation: "egress",
    url: "https://approved.example/apix",
  });
  expect(denied.error && /denied URL/i.test(denied.error.message),
    "same-origin disallowed-path egress was not denied");

  const tools = await post("/conformance/code-mode/alpha", {
    operation: "tools",
    value: { query: "safe" },
  });
  expect(tools.value?.catalog?.length === 1 &&
    tools.value.catalog[0].name === "echo" &&
    !Object.hasOwn(tools.value.catalog[0], "secret") &&
    tools.value.result?.agent === "alpha",
    "tool catalog or explicit invocation broker was not bounded");

  const output = await post("/conformance/code-mode/alpha", {
    operation: "output",
    size: 8 * 1024 * 1024 + 1024,
  });
  expect(output.requested > output.value?.result?.length &&
    output.value.result.length === 8 * 1024 * 1024 &&
    output.value.result.first === 65 && output.value.result.last === 65,
    "loaded-worker output was not deterministically truncated");
});

await step("Code Mode admission and error wire contract", async () => {
  const admission = await post("/conformance/code-mode/alpha", {
    operation: "admission",
  });
  const byLabel = new Map(admission.results?.map((result) => [result.label, result]));
  expect(byLabel.get("code_size")?.error?.code === "code_mode.code_size" &&
    byLabel.get("code_size")?.error?.retryable === false,
    "oversized Code Mode code did not expose a non-retryable wire error");
  expect(byLabel.get("env_size")?.error?.code === "code_mode.env_size" &&
    byLabel.get("env_size")?.error?.retryable === false,
    "oversized Code Mode env did not expose a non-retryable wire error");

  const timedOut = await post("/conformance/code-mode/alpha", {
    operation: "timeout",
    delayMs: 5_000,
  });
  expect(timedOut.error?.code === "code_mode.timeout" &&
    timedOut.error?.retryable === true,
    "bounded Code Mode timeout did not expose retryable wire metadata");
});

await step("deterministic streamed chat, messages, and resume", async () => {
  const response = await request("/conformance/chat/alpha", {
    method: "POST",
    body: JSON.stringify({ messages: [{ id: "e2e-chat-alpha", role: "user", content: "e2e chat alpha" }] }),
  });
  const responseId = response.headers.get("x-celld-response-id");
  const streamed = await response.text();
  expect(responseId, "chat response omitted x-celld-response-id");
  expect(streamed === "deterministic response for e2e chat alpha", "chat stream was not deterministic");
  const status = await json(`/conformance/resume/alpha?response=${encodeURIComponent(responseId)}&status=1`);
  expect(status.status === "complete" && status.cursor === 3, "chat stream was not durably completed");
  const resumed = await request(`/conformance/resume/alpha?response=${encodeURIComponent(responseId)}&after=1`);
  expect(await resumed.text() === "response for e2e chat alpha", "resume did not replay the remaining chunks");
  const messages = await json("/conformance/messages/alpha");
  expect(messages.some((message) => message.id === "e2e-chat-alpha") &&
    messages.some((message) => message.id === responseId && message.role === "assistant"),
  "persisted chat messages were incomplete");
});

await step("AI adapter", async () => {
  const adapter = await post("/conformance/ai-adapter/alpha", {
    messages: [{ id: "e2e-ai-alpha", role: "user", content: "e2e ai alpha" }],
  });
  expect(adapter.adapter === "http-ai" && adapter.result?.response === "deterministic response for e2e ai alpha",
    "AI adapter did not return the deterministic provider response");
});

await step("delayed Agent schedule/alarm", async () => {
  const before = await json("/conformance/schedule/beta");
  const scheduledRuns = before.state?.scheduledRuns ?? 0;
  await post("/conformance/schedule/beta", { delaySeconds: 2, payload: { job: "e2e-alarm" } });
  await eventually("delayed schedule/alarm", async () => {
    const status = await json("/conformance/schedule/beta");
    return status.state?.scheduledRuns > scheduledRuns && status.runs?.length > 0;
  });
});

console.log("PASS E2E workflow complete");
