import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function source(path) {
  return readFile(join(ROOT, path), "utf8");
}

function storageFor(database) {
  return {
    sql: {
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        let rows = [];
        try {
          rows = statement.all(...bindings);
        } catch (error) {
          if (!String(error?.message).includes("does not return data")) throw error;
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

async function loadPinnedShellWorker() {
  const bundleRoot = await mkdtemp(join(tmpdir(), "celld-worker-shell-"));
  const shim = join(bundleRoot, "cloudflare-workers-shim.mjs");
  const bundle = join(bundleRoot, "worker-shell.mjs");
  await writeFile(
    shim,
    "export class RpcTarget {}\n" +
      "export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n",
  );
  await build({
    stdin: {
      contents: [
        'export { Workspace } from "@cloudflare/computer";',
        'export { ShellWorker } from "@cloudflare/computer/backends/worker-shell";',
      ].join("\n"),
      resolveDir: FIXTURE_ROOT,
      sourcefile: "worker-shell-entry.mjs",
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
    ...module,
    close: () => rm(bundleRoot, { recursive: true, force: true }),
  };
}

async function collectEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function hostFor(workspace) {
  return workspace.stub();
}

test("Worker Shell source is pinned, loaded, capability-scoped, and no-egress", async () => {
  const [sourceText, harness, matrix, packageJson] = await Promise.all([
    source("examples/agents-conformance/index.js"),
    source("crates/celld/js/harness.js"),
    source("examples/agents-conformance/compatibility-matrix.md"),
    source("examples/agents-conformance/package.json"),
  ]);
  const packageData = JSON.parse(packageJson);
  assert.equal(packageData.dependencies["just-bash"], "3.4.0");
  assert.match(sourceText, /WorkerShellBackend/);
  assert.match(sourceText, /egress: \{ mode: "none" \}/);
  assert.match(sourceText, /backend: "worker-shell"/);
  assert.match(sourceText, /unsupported_command/);
  assert.match(sourceText, /timed_out/);
  assert.match(sourceText, /WorkspaceServiceProxy/);
  assert.match(harness, /__celld\$loaderCapability/);
  assert.match(harness, /Workspace capability only exposes getWorkspace and fs methods/);
  assert.match(harness, /globalThis\.\__loaderWorkerId/);
  assert.match(matrix, /just-bash@3\.4\.0/);
  assert.match(matrix, /Worker Shell backend.*adapted/);
  assert.doesNotMatch(sourceText, /shell\/(?:curl|python|sqlite|js-exec)/);
});

test("pinned Worker Shell mutates the same Workspace and reports unsupported commands", async () => {
  const { Workspace, ShellWorker, close } = await loadPinnedShellWorker();
  const root = await mkdtemp(join(tmpdir(), "celld-worker-shell-db-"));
  const database = new DatabaseSync(join(root, "agent.sqlite"));
  try {
    const workspace = new Workspace({ storage: storageFor(database) });
    const worker = new ShellWorker();
    worker.env = { HOST: { getWorkspace: async () => hostFor(workspace) } };

    const run = await worker.exec({
      id: "workspace-write",
      command: 'mkdir -p /notes && printf "hello\\n" > /notes/todo.md && cat /notes/todo.md',
    });
    const events = await collectEvents(run.events);
    assert.equal(events.at(-1).name, "exit");
    assert.equal(events.at(-1).value, 0);
    assert.equal(
      await workspace.fs.readFile("/notes/todo.md", "utf8"),
      "hello\n",
    );
    assert.equal(events.find((event) => event.name === "stdout")?.value, "hello\n");

    const unsupported = await worker.exec({
      id: "unsupported",
      command: "command-that-is-not-in-just-bash",
    });
    const unsupportedEvents = await collectEvents(unsupported.events);
    assert.equal(unsupportedEvents.at(-1).value, 127);
    assert.match(
      unsupportedEvents.find((event) => event.name === "stderr")?.value ?? "",
      /command not found|not found/i,
    );

    const network = await worker.exec({
      id: "ambient-network",
      command: "curl https://example.invalid",
    });
    const networkEvents = await collectEvents(network.events);
    assert.notEqual(networkEvents.at(-1).value, 0);
    assert.match(
      networkEvents.find((event) => event.name === "stderr")?.value ?? "",
      /fetch failed|not permitted|network/i,
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
    await close();
  }
});

test("Worker Shell interruption and timeout settle with explicit exit outcomes", async () => {
  const { ShellWorker, close } = await loadPinnedShellWorker();
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  try {
    class InterruptibleShellWorker extends ShellWorker {
      constructor() {
        super();
        this.bashFactoryOverride = async (_command, { signal }) => {
          started();
          await new Promise((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", resolve, { once: true });
          });
          return {
            stdout: "",
            stderr: "Execution cancelled\n",
            exitCode: 130,
          };
        };
      }
    }
    const worker = new InterruptibleShellWorker();
    worker.env = {
      HOST: {
        getWorkspace: async () => ({
          fs: {
            // The override does not touch the filesystem; these methods only
            // keep the ShellWorker host shape explicit for the test.
          },
          git: { cli: async () => ({ stdout: "", stderr: "", exitCode: 1 }) },
          artifacts: { cli: async () => ({ stdout: "", stderr: "", exitCode: 1 }) },
        }),
      },
    };
    const pending = worker.exec({ id: "interrupt", command: "wait" });
    await startedPromise;
    await worker.killExec({ id: "interrupt", signal: "SIGINT" });
    const events = await collectEvents((await pending).events);
    assert.equal(events.at(-1).name, "exit");
    assert.equal(events.at(-1).value, 130);
    assert.match(events.find((event) => event.name === "stderr")?.value ?? "", /cancelled/i);
  } finally {
    await close();
  }
});
