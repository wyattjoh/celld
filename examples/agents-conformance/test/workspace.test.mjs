import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { test } from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function storageFor(database) {
  return {
    sql: {
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        let rows = [];
        try {
          rows = statement.all(...bindings);
        } catch (error) {
          if (!String(error?.message).includes("does not return data")) {
            throw error;
          }
          statement.run(...bindings);
        }
        return { toArray: () => rows };
      },
    },
    transactionSync(closure) {
      database.exec("BEGIN");
      try {
        const result = closure();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the operation's original error.
        }
        throw error;
      }
    },
  };
}

async function loadPinnedWorkspace() {
  const bundleRoot = await mkdtemp(join(tmpdir(), "celld-computer-workspace-"));
  const shim = join(bundleRoot, "cloudflare-workers-shim.mjs");
  const bundle = join(bundleRoot, "computer.mjs");
  await writeFile(
    shim,
    "export class RpcTarget {}\nexport class WorkerEntrypoint {}\n",
  );
  await build({
    stdin: {
      contents: 'export { Workspace } from "@cloudflare/computer";',
      resolveDir: ROOT,
      sourcefile: "workspace-entry.mjs",
    },
    bundle: true,
    format: "esm",
    outfile: bundle,
    platform: "node",
    plugins: [{
      name: "cloudflare-workers-shim",
      setup(plugin) {
        plugin.onResolve(
          { filter: /^cloudflare:workers$/ },
          () => ({ path: shim }),
        );
      },
    }],
  });
  const module = await import(pathToFileURL(bundle).href);
  return {
    Workspace: module.Workspace,
    close: () => rm(bundleRoot, { recursive: true, force: true }),
  };
}

test("pinned filesystem-only Workspace operations persist and stay isolated", async () => {
  const { Workspace, close } = await loadPinnedWorkspace();
  const root = await mkdtemp(join(tmpdir(), "celld-computer-workspace-db-"));
  const alphaPath = join(root, "alpha.sqlite");
  const betaPath = join(root, "beta.sqlite");
  let alphaDatabase = new DatabaseSync(alphaPath);
  const betaDatabase = new DatabaseSync(betaPath);

  try {
    const alpha = new Workspace({ storage: storageFor(alphaDatabase) });
    const beta = new Workspace({ storage: storageFor(betaDatabase) });

    await alpha.fs.mkdir("/plans", { recursive: true });
    await alpha.fs.writeFile("/notes.md", "alpha TODO\n", { exclusive: true });
    await alpha.fs.writeFile("/plans/plan.md", "alpha plan\n", { exclusive: true });
    await assert.rejects(
      alpha.fs.writeFile("/notes.md", "duplicate\n", { exclusive: true }),
      (error) => error?.code === "EEXIST",
    );
    assert.equal(await alpha.fs.readFile("/notes.md", "utf8"), "alpha TODO\n");
    assert.deepEqual(await alpha.fs.ls("/"), ["/notes.md", "/plans/plan.md"]);
    assert.deepEqual(await alpha.fs.grep("todo", "/", { ignoreCase: true }), [
      { path: "/notes.md", line: 1, text: "alpha TODO" },
    ]);

    await alpha.fs.writeFile("/notes.md", "alpha updated\n");
    assert.equal(
      await alpha.fs.readFile("/notes.md", "utf8"),
      "alpha updated\n",
    );
    await alpha.fs.rm("/plans", { recursive: true });
    assert.deepEqual(await alpha.fs.ls("/"), ["/notes.md"]);

    await beta.fs.writeFile("/notes.md", "beta only\n", { exclusive: true });
    assert.equal(await beta.fs.readFile("/notes.md", "utf8"), "beta only\n");
    await assert.rejects(beta.fs.readFile("/alpha-only.md", "utf8"));

    alphaDatabase.close();
    alphaDatabase = new DatabaseSync(alphaPath);
    const restoredAlpha = new Workspace({
      storage: storageFor(alphaDatabase),
    });
    assert.equal(
      await restoredAlpha.fs.readFile("/notes.md", "utf8"),
      "alpha updated\n",
    );
    await assert.rejects(restoredAlpha.fs.readFile("/plans/plan.md", "utf8"));
    assert.equal(await beta.fs.readFile("/notes.md", "utf8"), "beta only\n");
  } finally {
    alphaDatabase.close();
    betaDatabase.close();
    await rm(root, { recursive: true, force: true });
    await close();
  }
});
