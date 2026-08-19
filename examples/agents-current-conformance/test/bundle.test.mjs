import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url);

test("the current target bundles with celld's builtin boundary", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "celld-agents-current-bundle-"));
  const outfile = join(outputRoot, "index.js");
  try {
    await build({
      absWorkingDir: new URL(ROOT).pathname,
      entryPoints: ["index.js"],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2024",
      conditions: ["workerd", "worker", "browser"],
      external: ["node:*", "cloudflare:*", "path"],
      outfile,
    });
    const bundle = await readFile(outfile, "utf8");
    assert.match(bundle, /CurrentConformanceAgent/);
    assert.match(bundle, /__require\(["']path["']\)/);
    assert.match(bundle, /cloudflare:workers/);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
