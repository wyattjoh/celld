import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function source(path) {
  return readFile(join(ROOT, path), "utf8");
}

test("Worker Loader uses an explicit capability sideband and opaque proxy", async () => {
  const harness = await source("crates/celld/js/harness.js");
  assert.match(harness, /__celldCapability/);
  assert.match(harness, /__loader_capability_call/);
  assert.match(harness, /__loader_capability_grant/);
  assert.match(harness, /__loader_capability_revoke/);
  assert.match(harness, /__loader_capability_drop/);
  assert.match(harness, /__loader_capability_target/);
  assert.match(harness, /__loader_capability_allowlist/);
  assert.match(harness, /__loader_load\(\s*JSON\.stringify\(config\), wasm,/);
  assert.match(harness, /agentScope/);
  assert.match(harness, /if \(prop === "then"\) return undefined/);
  assert.match(harness, /Workspace capability only exposes getWorkspace and fs methods/);
  assert.match(harness, /__loaderCapabilityFinalizer/);
  assert.match(harness, /nested method proxy keeps the root alive/);
  assert.match(harness, /handle\.token/);
});

test("Ticket 06 direct Workspace paths remain compatible with Worker Shell views", async () => {
  const harness = await source("crates/celld/js/harness.js");
  const docs = await source("docs/cloudflare-compat.md");
  assert.match(harness, /const directFsPath = path\.length === 2 && path\[0\] === "fs"/);
  assert.match(harness, /const shellFsPath = path\.length === 3/);
  assert.match(harness, /path\[0\] === "getWorkspace" && path\[1\] === "fs"/);
  assert.match(docs, /WORKSPACE\.fs\.readFile\(path, "utf8"\)/);
  assert.match(harness, /Workspace capability only exposes getWorkspace and fs methods/);
  assert.match(harness, /library capability paths must name one method/);
  assert.match(harness, /attachOutputBytes/);
  assert.match(harness, /bounded transport size/);
  assert.match(harness, /__celld\$loaderCapability/);
  assert.match(harness, /typeof wrapped\.js === "string"/);
});

test("global fetch routes through the explicit broker instead of ambient egress", async () => {
  const harness = await source("crates/celld/js/harness.js");
  const start = harness.indexOf("globalThis.fetch = async");
  const end = harness.indexOf("\nglobalThis.__fetchWebSocketUpgrade", start);
  assert.ok(start >= 0 && end > start, "global fetch implementation is present");
  const vmContext = vm.createContext({
    Array, Error, JSON, Promise, Symbol, Uint8Array,
    Request: class Request {
      constructor(input, init = {}) {
        this.url = String(input);
        this.method = String(init.method ?? "GET").toUpperCase();
        this.redirect = init.redirect ?? "follow";
        this.headers = new Map(init.headers ?? []);
        this._bodyBytes = init.body ?? null;
      }
      async _consume() { return this._bodyBytes ?? new Uint8Array(); }
    },
    Response: class Response {
      constructor(body) { this.body = body; }
      async text() { return String(this.body); }
    },
    CelldHttpBodyStream: class {},
    __fetchWebSocketUpgrade: async () => { throw new Error("unexpected websocket"); },
    __op_fetch: async () => { throw new Error("ambient egress"); },
  });
  vm.runInContext(`
    let __loaderOutbound = null;
    ${harness.slice(start, end)}
    globalThis.__setTestOutbound = (value) => { __loaderOutbound = value; };
    globalThis.__testFetch = globalThis.fetch;
  `, vmContext);
  await assert.rejects(
    vmContext.__testFetch("https://ambient.example"),
    /ambient egress/,
  );
  vmContext.__setTestOutbound(async (request) => new vmContext.Response(
    `broker:${request.url}`,
  ));
  const response = await vmContext.__testFetch("https://approved.example");
  assert.equal(await response.text(), "broker:https://approved.example");
});

test("Fetcher broker allowlists are origin-and-path scoped", async () => {
  const harness = await source("crates/celld/js/harness.js");
  const start = harness.indexOf("const __loaderFetcherAllowed =");
  const end = harness.indexOf("\n\nglobalThis.__makeLoaderCapability", start);
  assert.ok(start >= 0 && end > start, "Fetcher policy helper is present");
  const policy = vm.runInNewContext(
    `${harness.slice(start, end)}; __loaderFetcherAllowed`,
    { URL },
  );
  const allow = ["https://approved.example/api"];
  assert.equal(policy("https://approved.example/api", allow), true);
  assert.equal(policy("https://approved.example/api/v1", allow), true);
  assert.equal(policy("https://approved.example/apix", allow), false);
  assert.equal(policy("https://other.example/api", allow), false);
  assert.equal(policy("ftp://approved.example/api", allow), false);
  assert.equal(policy("not a URL", allow), false);
  assert.equal(policy("https://approved.example/api", []), false);
});

test("tool catalogs are normalized to host-approved metadata", async () => {
  const harness = await source("crates/celld/js/harness.js");
  const safeStart = harness.indexOf("const __loaderCapabilitySafe =");
  const safeEnd = harness.indexOf("\n\nglobalThis.__makeLoaderCapability", safeStart);
  const catalogStart = harness.indexOf("  const catalogForLoader =", safeEnd);
  const catalogEnd = harness.indexOf("\n  const encodeCapability", catalogStart);
  assert.ok(catalogStart >= 0 && catalogEnd > catalogStart, "catalog helper is present");
  const sourceCode = `${harness.slice(safeStart, safeEnd)}\n${harness.slice(catalogStart, catalogEnd)}; catalogForLoader`;
  const catalogForLoader = vm.runInNewContext(sourceCode, { Set, Object, JSON });
  assert.deepEqual(
    JSON.parse(JSON.stringify(catalogForLoader([{
      name: "search",
      description: "Search approved documents",
      inputSchema: { type: "object" },
      secret: "must not be copied",
    }]))),
    [{
      name: "search",
      description: "Search approved documents",
      inputSchema: { type: "object" },
    }],
  );
  assert.throws(
    () => catalogForLoader([{ name: "__proto__" }]),
    /safe name/,
  );
});

test("Agent eviction invalidates named loader workers before reactivation", async () => {
  const harness = await source("crates/celld/js/harness.js");
  const start = harness.indexOf("const __loaderClearers = [];");
  const end = harness.indexOf("\nglobalThis.__makeServiceBinding", start);
  assert.ok(start >= 0 && end > start, "loader cache implementation is present");
  let loads = 0;
  const context = vm.createContext({
    Array, ArrayBuffer, FinalizationRegistry, JSON, Map, Object, Promise,
    Set, Symbol, Uint8Array, URL,
    __actorEventStack: ["Agent:alpha"],
    __loaderCapabilitySafe: () => true,
    __loader_load: () => ++loads,
    __loader_drop() {},
  });
  vm.runInContext(`${harness.slice(start, end)}\n` +
    "globalThis.__testLoader = __makeLoader();", context);
  const code = {
    mainModule: "worker.js",
    modules: { "worker.js": "export default { fetch() {} };" },
  };
  context.__testLoader.get("named", () => code);
  await Promise.resolve();
  await Promise.resolve();
  let resolveLate;
  const lateStub = context.__testLoader.get(
    "late",
    () => new Promise((resolve) => { resolveLate = resolve; }),
  );
  await Promise.resolve();
  context.__clearLoaderAgent("Agent:alpha");
  resolveLate(code);
  await Promise.resolve();
  await Promise.resolve();
  await assert.rejects(
    lateStub.getEntrypoint().fetch("https://late.example"),
    /Agent scope was evicted/,
  );
  context.__testLoader.get("named", () => code);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(loads, 2, "reactivation must load a fresh named worker");
});

test("runtime checks capability identity and denies ambient loaded-worker egress", async () => {
  const runtime = await source("crates/celld/js.rs");
  const driver = await source("crates/celld/runtime.rs");
  assert.match(runtime, /capability::authorize/);
  assert.match(runtime, /capability owner mismatch/);
  assert.match(runtime, /capability worker mismatch/);
  assert.match(runtime, /capability kind mismatch/);
  assert.match(runtime, /capability is disposed/);
  assert.match(runtime, /globalOutbound: null/);
  assert.match(runtime, /EgressPolicy::Deny/);
  assert.match(runtime, /random_loader_token/);
  assert.match(runtime, /host_loader_entry/);
  assert.match(runtime, /loaded workers cannot control sibling workers/);
  assert.match(runtime, /HostCellLost/);
  assert.match(runtime, /loader_result_error/);
  assert.match(runtime, /capability_cancel/);
  assert.match(runtime, /worker loader: cancelled/);
  assert.match(runtime, /worker loader: timed_out/);
  assert.match(driver, /worker loader: host_cell_lost/);
  assert.match(runtime, /try_turn/);
  assert.match(runtime, /shutdown_loader_registry/);
  assert.match(runtime, /capability grants require a host isolate/);
  assert.match(runtime, /CapabilityKind::Library/);
  assert.match(runtime, /CapabilityKind::Fetcher/);
  assert.match(runtime, /CapabilityKind::Tools/);
  assert.match(runtime, /with_main_module\(main\.to_string\(\)\)/);
  assert.match(runtime, /register_main_module/);
  assert.match(runtime, /Fetcher brokers require a non-empty allowlist/);
  assert.match(runtime, /globalOutbound must be an explicit Fetcher broker/);
  assert.match(runtime, /loader_capability_allowlist/);
  assert.match(runtime, /loaded workers cannot invoke worker stubs/);
  assert.match(runtime, /worker stub Agent scope mismatch/);
  assert.match(runtime, /HOST_ONLY/);
  assert.match(runtime, /evict_loader_agent/);
  assert.match(runtime, /struct StreamOwner/);
  assert.match(runtime, /response stream owner mismatch/);
  assert.match(runtime, /current_stream_owner/);
});

test("loaded Workers replace raw host authority ops", async () => {
  const runtime = await source("crates/celld/js.rs");
  const start = runtime.indexOf("const HOST_ONLY: &[&str] = &[");
  const end = runtime.indexOf("];", start);
  assert.ok(start >= 0 && end > start, "host-only op list is present");
  const names = [...runtime.slice(start, end).matchAll(/\"(__[^\"]+)\"/g)]
    .map((match) => match[1]);
  for (const name of [
    "__svc_call", "__svc_rpc", "__do_call", "__rpc_call",
    "__storage_get", "__storage_put", "__sql_exec", "__alarm_set",
    "__loader_fetch", "__loader_rpc", "__loader_drop",
  ]) assert.ok(names.includes(name), `${name} is host-only`);
});

test("normal Workers retain inherited outbound behavior while brokers stay explicit", async () => {
  const harness = await source("crates/celld/js/harness.js");
  const runtime = await source("crates/celld/js.rs");
  assert.match(harness, /config\.globalOutbound !== undefined && config\.globalOutbound !== null/);
  assert.match(harness, /delete config\.globalOutbound/);
  assert.match(harness, /__loaderOutbound !== null/);
  assert.match(harness, /process-global stream ids never become loaded-worker\s+\/\/\s+authority handles/);
  assert.match(runtime, /None => actor_runtime_state\(scope\)\.egress/);
});

test("host env injection materializes only opaque loaded-worker proxies", async () => {
  const bootstrap = await source("crates/celld/js/bootstrap.rs");
  const harness = await source("crates/celld/js/harness.js");
  const runtime = await source("crates/celld/js.rs");
  assert.match(bootstrap, /__makeLoaderCapability/);
  assert.match(bootstrap, /__setLoaderOutbound/);
  assert.match(bootstrap, /loader_capabilities/);
  assert.match(harness, /__clearLoaderAgent/);
  assert.match(harness, /byName.delete/);
  assert.match(harness, /agentGenerations/);
  assert.match(harness, /Agent scope was evicted/);
  assert.match(runtime, /clear_loader_agent/);
  assert.match(runtime, /worker loader: host internal operation is unavailable/);
  assert.match(runtime, /CapabilityKind::Tools/);
  assert.match(runtime, /release_loader_capabilities/);
  assert.match(runtime, /release_loader_entry/);
  assert.match(runtime, /in-flight calls settle/);
  assert.match(runtime, /revoke_loader_entries_for_scope/);
  assert.match(runtime, /wait_idle_bounded/);
  assert.match(bootstrap, /loaded module is untrusted/);
  assert.match(bootstrap, /delete globalThis.__makeLoaderCapability/);
  assert.match(runtime, /op_loader_capability_grant/);
  assert.match(runtime, /op_loader_capability_revoke/);
  assert.match(runtime, /\.remove\(&token\)/);
});

test("capability interruption classes and clone-only transport are explicit", async () => {
  const logic = await source("crates/logic/capability.rs");
  const docs = await source("docs/cloudflare-compat.md");
  for (const name of [
    "cancelled", "timed_out", "isolate_failure", "capability_failure",
    "host_cell_lost", "worker_disposed",
  ]) assert.match(logic, new RegExp(name));
  assert.match(docs, /streams, stream handles,\s+backpressure/);
  assert.match(docs, /losing ownership/);
});

test("the pinned Worker JavaScript fixture uses only the explicit library bridge", async () => {
  const fixture = await source("examples/agents-conformance/index.js");
  assert.match(fixture, /@cloudflare\/computer\/backends\/worker-javascript/);
  assert.match(fixture, /new WorkerJavaScriptBackend/);
  assert.match(fixture, /loader\.capability\("library", library\)/);
  assert.match(fixture, /node:fs\/promises/);
  assert.match(fixture, /DEFAULT_JAVASCRIPT_SOURCE/);
  assert.match(fixture, /LOADER_MODULE_SOURCE/);
  assert.match(fixture, /add\.wasm/);
  assert.match(fixture, /workspace\/nested\/loader-helper\.js/);
  assert.match(fixture, /operation === "loader-modules"/);
  assert.match(fixture, /\/conformance\/javascript\//);
});

test("Worker JavaScript failure paths stay bounded and no-egress", async () => {
  const fixture = await source("examples/agents-conformance/index.js");
  const docs = await source("examples/agents-conformance/README.md");
  assert.match(fixture, /operation === "cancel"/);
  assert.match(fixture, /status: result\.status/);
  assert.match(docs, /CELLD_WORKER_LOADER=LOADER/);
  assert.match(docs, /non-JSON/);
  assert.match(docs, /no\s+ambient network access/);
});

test("Code Mode admission bounds are distinct and pressure preserves cell authority", async () => {
  const runtime = await source("crates/celld/js.rs");
  const logic = await source("crates/logic/code_mode.rs");
  const main = await source("crates/celld/main.rs");
  assert.match(logic, /CodeSize/);
  assert.match(logic, /EnvSize/);
  assert.match(logic, /WorkerLimit/);
  assert.match(logic, /ConcurrencyLimit/);
  assert.match(logic, /MemoryLimit/);
  assert.match(logic, /Pressured/);
  assert.match(logic, /ErrorKind/);
  assert.match(logic, /retryable/);
  assert.match(runtime, /loader_throw_code/);
  assert.match(runtime, /retryable_key/);
  assert.match(runtime, /CELLD_MAX_LOADED_WORKER_CONCURRENCY/);
  assert.match(runtime, /CELLD_LOADED_WORKER_TIMEOUT_S/);
  assert.match(runtime, /memory admission limit exceeded/);
  assert.match(runtime, /pressure shedding rejects new Code Mode work/);
  assert.match(runtime, /revoke_loader_capabilities_for_slot/);
  assert.match(runtime, /EXECUTION_TIMEOUT_WIRE_ERROR/);
  assert.match(runtime, /drive_loaded_worker/);
  assert.match(main, /set_code_mode_pressure/);
  assert.match(main, /authoritative Workspace state remain/);
});
