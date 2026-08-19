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
