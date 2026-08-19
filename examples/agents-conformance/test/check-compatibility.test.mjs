import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createModelProviderServer } from "../scripts/model-provider.mjs";
import { checkCompatibility } from "../scripts/check-compatibility.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_FILES = [
  "compatibility.json",
  "compatibility-matrix.md",
  "index.js",
  "package-lock.json",
  "package.json",
  "wrangler.jsonc",
];

async function copyFixture() {
  const root = await mkdtemp(join(tmpdir(), "celld-agents-compatibility-"));
  await Promise.all(
    FIXTURE_FILES.map((name) => cp(join(ROOT, name), join(root, name))),
  );
  return root;
}

test("the checked-in Agents, AI, Computer, and Worker Shell target is exact", () => {
  assert.deepEqual(checkCompatibility(ROOT), {
    agentsVersion: "0.0.16",
    aiVersion: "4.3.19",
    computerVersion: "0.2.1",
    zodVersion: "3.25.76",
    lockfileSha256:
      "58a8d0772f3b32269294c3762c82aa614943ae298bf9b5160dd477562e5c851e",
  });
});

test("the fixture declares private Agent state and SQL lifecycle surfaces", async () => {
  const source = await readFile(join(ROOT, "index.js"), "utf8");
  assert.match(source, /stateAndSql\(input\)/);
  assert.match(source, /conformance_agent_records/);
  assert.ok(source.includes('url.pathname.match(/^\\/conformance\\/state\\/([^/]+)$/)'));
  assert.match(source, /this\.setState\(\{ agent: name, value, revision \}\)/);
  assert.match(source, /SELECT id, value, revision/);
});

test("the fixture declares hibernating sessions and alarm-backed delayed work", async () => {
  const source = await readFile(join(ROOT, "index.js"), "utf8");
  const readme = await readFile(join(ROOT, "README.md"), "utf8");

  assert.match(source, /onConnect\(connection\)/);
  assert.match(source, /onMessage\(connection, message\)/);
  assert.match(source, /conformance_agent_session_state/);
  assert.match(source, /conformance_agent_session_events/);
  assert.match(source, /persistSessionState\(next\)/);
  assert.match(source, /async scheduleWork\(input\)/);
  assert.match(source, /this\.schedule\(/);
  assert.match(source, /recordScheduledWork\(payload, schedule\)/);
  assert.ok(source.includes("/conformance/session/"));
  assert.ok(source.includes("/conformance/schedule/"));
  assert.match(readme, /hibernat/i);
  assert.match(readme, /storage\.setAlarm\(\)/);
  assert.match(readme, /evict\/ConformanceAgent:alpha/);
});

test("the deployed fixture keeps its Agent namespace binding addressable", async () => {
  const wrangler = JSON.parse(await readFile(join(ROOT, "wrangler.jsonc"), "utf8"));
  assert.equal(wrangler.durable_objects.bindings[0].name, "agents");
  assert.equal(wrangler.durable_objects.bindings[0].class_name, "ConformanceAgent");
});

test("the fixture wires a filesystem-only Workspace to each Agent cell", async () => {
  const source = await readFile(join(ROOT, "index.js"), "utf8");
  assert.match(source, /getWorkspace,[\s\S]*withWorkspace/);
  assert.match(source, /export class ConformanceAgent extends withWorkspace\(/);
  assert.match(source, /storage: self\.ctx\.storage/);
  for (const operation of ["create", "read", "update", "list", "search", "delete"]) {
    assert.match(source, new RegExp(`\\\"${operation}\\\"`));
  }
  assert.match(source, /workspace\.fs\.writeFile/);
  assert.match(source, /workspace\.fs\.readFile/);
  assert.match(source, /workspace\.fs\.ls/);
  assert.match(source, /workspace\.fs\.grep/);
  assert.match(source, /workspace\.fs\.rm/);
  assert.ok(source.includes("/conformance/workspace/alpha"));
  assert.match(source, /WorkerShellBackend/);
  assert.match(source, /WorkerJavaScriptBackend/);
  assert.match(source, /egress: \{ mode: "none" \}/);
  assert.match(source, /loader: computerLoader\(loader\)/);
  assert.match(source, /globalOutbound: null/);
  assert.match(source, /loader\.capability\("library", library\)/);
  assert.match(source, /\/conformance\/shell\/alpha/);
  assert.match(source, /\/conformance\/javascript\/alpha/);
});

test("the source-unmodified AIChatAgent seam persists complete HTTP streams", async () => {
  const source = await readFile(join(ROOT, "index.js"), "utf8");
  assert.ok(source.includes('from "@cloudflare/agents/ai-chat-agent"'));
  assert.match(source, /extends (?:AIChatAgent|withWorkspace\(\s*AIChatAgent)/);
  assert.match(source, /cf_ai_chat_agent_messages/);
  assert.match(source, /conformance_ai_responses/);
  assert.match(source, /conformance_ai_response_chunks/);
  assert.match(source, /lease_until/);
  assert.match(source, /startLeaseRenewal/);
  assert.match(source, /renewResponse/);
  assert.match(source, /10_000/);
  assert.match(source, /crypto\.subtle\.digest/);
  assert.match(source, /x-celld-resume-after/);
  assert.match(source, /ndjson-v1/);
  assert.match(source, /invalid stream frame/);
  assert.match(source, /searchParams\.get\("status"\)/);
  assert.match(source, /providerResponse\.body\.getReader/);
  assert.match(source, /before exposing it/);
  assert.match(source, /response resume lease was lost/);
  assert.match(source, /conformance\/resume/);
  assert.match(source, /appendResponseMessages/);
  assert.match(source, /MODEL_PROVIDER_URL HTTP deployment capability/);
  assert.match(source, /AI adapter deployment capability is missing/);
  assert.match(source, /HTTP model provider returned status/);
  assert.match(source, /HTTP model provider returned no response stream/);
  assert.match(source, /safeErrorMessage/);
  assert.match(source, /status: invalid \? 400 : missing \? 503 : 502/);
  assert.match(source, /invalid_request/);
  assert.doesNotMatch(source, /(api[_-]?key|secret|bearer)\s*[:=]/i);
});

test("the AI adapter exposes a stable missing-capability error", async () => {
  const harness = await readFile(
    join(ROOT, "../../crates/celld/js/harness.js"),
    "utf8",
  );
  assert.match(harness, /__makeMissingAiBinding/);
  assert.match(harness, /CELLD_AI_URL deployment capability/);
});

test("the deterministic provider emits framed responses across write boundaries", async () => {
  const providerSource = await readFile(join(ROOT, "scripts/model-provider.mjs"), "utf8");
  assert.match(providerSource, /ndjson-v1/);
  assert.match(providerSource, /midpoint/);

  const server = createModelProviderServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const body = JSON.stringify({
      model: "celld-deterministic-test",
      messages: [{ id: "m1", role: "user", content: "hello" }],
    });
    const stream = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get("x-celld-stream-format"), "ndjson-v1");
    const streamFrames = (await stream.text()).trim().split("\n").map(JSON.parse);
    assert.deepEqual(streamFrames.map((frame) => frame.sequence), [1, 2, 3]);
    assert.equal(streamFrames.map((frame) => frame.text).join(""), "deterministic response for hello");

    const resumed = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-celld-response-id": "alpha-response-1:m1",
        "x-celld-resume-after": "1",
      },
      body,
    });
    assert.equal(resumed.status, 200);
    const resumedFrames = (await resumed.text()).trim().split("\n").map(JSON.parse);
    assert.deepEqual(resumedFrames.map((frame) => frame.sequence), [2, 3]);
    assert.equal(resumedFrames.map((frame) => frame.text).join(""), "response for hello");

    const invalidProviderRequest = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(invalidProviderRequest.status, 400);

    const adapter = await fetch(`${base}/v1/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "celld-deterministic-test",
        input: { messages: [{ id: "m2", role: "user", content: "hello" }] },
      }),
    });
    assert.deepEqual(await adapter.json(), {
      model: "celld-deterministic-test",
      response: "deterministic response for hello",
      complete: true,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a direct upstream version change fails with a stable error", async () => {
  const root = await copyFixture();
  const path = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(path, "utf8"));
  packageJson.dependencies["@cloudflare/agents"] = "0.0.15";
  await writeFile(path, `${JSON.stringify(packageJson, null, 2)}\n`);

  assert.throws(
    () => checkCompatibility(root),
    /\[compatibility\.package-version\].+@cloudflare\/agents/,
  );
});

test("a lockfile change fails until the reviewed target digest changes", async () => {
  const root = await copyFixture();
  const path = join(root, "package-lock.json");
  await writeFile(path, `${await readFile(path, "utf8")}\n`);

  assert.throws(
    () => checkCompatibility(root),
    /\[compatibility\.lockfile-hash\]/,
  );
});

test("the matrix must retain all three decision categories", async () => {
  const root = await copyFixture();
  const path = join(root, "compatibility-matrix.md");
  const matrix = await readFile(path, "utf8");
  await writeFile(path, matrix.replace(/\| adapted \|/gi, "| deferred |"));

  assert.throws(
    () => checkCompatibility(root),
    /\[compatibility\.matrix-status\].+adapted/,
  );
});
