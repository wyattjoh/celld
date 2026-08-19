import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
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

test("the checked-in Agents and Computer target is exact", () => {
  assert.deepEqual(checkCompatibility(ROOT), {
    agentsVersion: "0.0.16",
    computerVersion: "0.2.1",
    lockfileSha256:
      "d87c57cdd782fafd9847e383145c3b8669d8fe860e665ca793e74750f1e4497c",
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
  assert.match(source, /getWorkspace, withWorkspace/);
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
  assert.doesNotMatch(source, /WorkerShellBackend|WorkerJavaScriptBackend/);
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
