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
  const root = await mkdtemp(join(tmpdir(), "celld-agents-current-compatibility-"));
  await Promise.all(FIXTURE_FILES.map((name) => cp(join(ROOT, name), join(root, name))));
  return root;
}

test("the checked-in current Agents SDK target is exact", () => {
  assert.deepEqual(checkCompatibility(ROOT), {
    agentsVersion: "0.21.0",
    aiChatVersion: "0.10.2",
    aiVersion: "6.0.259",
    openaiVersion: "3.0.98",
    zodVersion: "4.4.3",
    esbuildVersion: "0.28.2",
    lockfileSha256:
      "7be9d2518eed1483b43340d44e7fe24a28be32db0ed0595730e0887686718544",
  });
});

test("the target uses the current public routing surface", async () => {
  const source = await readFile(join(ROOT, "index.js"), "utf8");
  assert.match(source, /from "agents"/);
  assert.match(source, /from "@cloudflare\/ai-chat"/);
  assert.match(source, /extends AIChatAgent/);
  assert.match(source, /getAgentByName/);
  assert.match(source, /routeAgentRequest/);
  assert.match(source, /onRequest\(request\)/);
  assert.match(source, /onConnect\(connection, ctx\)/);
  assert.match(source, /onMessage\(connection, message\)/);
  assert.doesNotMatch(source, /@cloudflare\/agents|vendor|patched/);

  const wrangler = JSON.parse(await readFile(join(ROOT, "wrangler.jsonc"), "utf8"));
  assert.deepEqual(wrangler.durable_objects.bindings, [
    { name: "CurrentConformanceAgent", class_name: "CurrentConformanceAgent" }
  ]);
});

test("the matrix records supported, adapted, and unsupported decisions", async () => {
  const matrix = await readFile(join(ROOT, "compatibility-matrix.md"), "utf8");
  for (const status of ["supported", "adapted", "unsupported"]) {
    assert.match(matrix, new RegExp(`\\|\\s*${status}\\s*\\|`, "i"));
  }
  assert.match(matrix, /agents@0\.21\.0/);
  assert.match(matrix, /@cloudflare\/ai-chat@0\.10\.2/);
  assert.match(matrix, /ai@6\.0\.259/);
  assert.match(matrix, /@ai-sdk\/openai@3\.0\.98/);
});

test("a direct package version change fails with a stable error", async () => {
  const root = await copyFixture();
  const path = join(root, "package.json");
  const packageJson = JSON.parse(await readFile(path, "utf8"));
  packageJson.dependencies.agents = "0.20.1";
  await writeFile(path, `${JSON.stringify(packageJson, null, 2)}\n`);

  assert.throws(() => checkCompatibility(root), /\[compatibility\.package-version\].+agents/);
});

test("a lockfile change fails until the reviewed target digest changes", async () => {
  const root = await copyFixture();
  const path = join(root, "package-lock.json");
  await writeFile(path, `${await readFile(path, "utf8")}\n`);

  assert.throws(() => checkCompatibility(root), /\[compatibility\.lockfile-hash\]/);
});
