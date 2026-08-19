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
        'export { ShellWorker, WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";',
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

async function collectDecodedEvents(stream) {
  const reader = stream.getReader();
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) return events;
    events.push(value);
  }
}

function hostFor(workspace) {
  return workspace.stub();
}

function capabilityWorkspaceView(target, onDispose) {
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    onDispose();
    target[Symbol.dispose]?.();
  };
  const make = (path) => new Proxy(function () {}, {
    get: (_base, prop) => {
      if (prop === "then") return undefined;
      if (prop === "dispose" || prop === Symbol.dispose) return dispose;
      if (typeof prop !== "string") return undefined;
      return make([...path, prop]);
    },
    apply: (_base, _this, args) => {
      let receiver = target;
      for (let index = 0; index < path.length - 1; index++) {
        receiver = receiver[path[index]];
      }
      const method = receiver[path[path.length - 1]];
      return Reflect.apply(method, receiver, args);
    },
  });
  return make([]);
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
  assert.match(sourceText, /workspace\.runtime\.exec\(command,/);
  assert.match(sourceText, /unsupported_command/);
  assert.match(sourceText, /timed_out/);
  assert.match(sourceText, /WorkspaceServiceProxy/);
  assert.match(harness, /__celld\$loaderCapability/);
  assert.match(harness, /service\?\.name === "WorkspaceServiceProxy"/);
  assert.match(harness, /path\.length === 0 \? drop/);
  assert.match(harness, /workspaceView\?\.\[Symbol\.dispose\]/);
  assert.match(harness, /capabilityDescriptor\(value, name\)/);
  assert.match(harness, /Workspace capability only exposes getWorkspace and fs methods/);
  assert.match(harness, /globalThis\.\__loaderWorkerId/);
  assert.match(matrix, /just-bash@3\.4\.0/);
  assert.match(matrix, /Worker Shell backend.*adapted/);
  assert.doesNotMatch(sourceText, /shell\/(?:curl|python|sqlite|js-exec)/);
});

test("WorkerShellBackend loads ShellWorker with its WorkspaceServiceProxy capability", async () => {
  const { Workspace, ShellWorker, WorkerShellBackend, close } =
    await loadPinnedShellWorker();
  const root = await mkdtemp(join(tmpdir(), "celld-worker-shell-loader-"));
  const database = new DatabaseSync(join(root, "agent.sqlite"));
  let connection;
  try {
    const workspace = new Workspace({ storage: storageFor(database) });
    let loadedCode;
    let disposedViews = 0;
    const hostService = function WorkspaceServiceProxyStub() {};
    hostService.getWorkspace = async () => capabilityWorkspaceView(
      workspace.stub(),
      () => { disposedViews++; },
    );
    const loader = {
      get(name, getCode) {
        loadedCode = getCode();
        assert.equal(name, "workspace-shell:ConformanceAgent:alpha:egress-none");
        return {
          getEntrypoint(entrypoint) {
            assert.equal(entrypoint, "ShellWorker");
            const shell = new ShellWorker();
            shell.env = {
              HOST: {
                getWorkspace: async () => loadedCode.env.HOST.getWorkspace(),
              },
            };
            return {
              exec: ({ command, ...input }) =>
                shell.exec({ ...input, command }),
              getExec: (input) => shell.getExec(input),
              killExec: (input) => shell.killExec(input),
              [Symbol.dispose]() {},
            };
          },
          [Symbol.dispose]() {},
        };
      },
    };
    const ctx = {
      exports: {
        WorkspaceServiceProxy({ props }) {
          assert.deepEqual(props, {
            binding: "agents",
            id: "ConformanceAgent:alpha",
          });
          return hostService;
        },
      },
    };
    const backend = new WorkerShellBackend({
      id: "worker-shell",
      loader,
      workspace: { binding: "agents", id: "ConformanceAgent:alpha" },
      ctx,
      egress: { mode: "none" },
    });
    connection = await backend.connect();
    assert.equal(loadedCode.globalOutbound, null);
    assert.equal(loadedCode.env.HOST, hostService);
    const envelope = await connection.rpc.shell.exec({
      source: 'mkdir -p /notes && printf "loaded\\n" > /notes/todo.md && cat /notes/todo.md',
    });
    const events = await collectDecodedEvents(envelope.events);
    assert.equal(events.at(-1).name, "exit");
    assert.equal(events.at(-1).code, 0);
    assert.equal(
      new TextDecoder().decode(events.find((event) => event.name === "stdout").value),
      "loaded\n",
    );
    assert.equal(await workspace.fs.readFile("/notes/todo.md", "utf8"), "loaded\n");
    const second = await connection.rpc.shell.exec({
      source: "cat /notes/todo.md",
    });
    const secondEvents = await collectDecodedEvents(second.events);
    assert.equal(secondEvents.at(-1).code, 0);
    assert.equal(disposedViews, 2);
  } finally {
    await connection?.close();
    database.close();
    await rm(root, { recursive: true, force: true });
    await close();
  }
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
