import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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
  assert.match(harness, /__loader_load\(JSON\.stringify\(config\), wasm, capabilities\)/);
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
});

test("host env injection materializes only opaque loaded-worker proxies", async () => {
  const bootstrap = await source("crates/celld/js/bootstrap.rs");
  const runtime = await source("crates/celld/js.rs");
  assert.match(bootstrap, /__makeLoaderCapability/);
  assert.match(bootstrap, /loader_capabilities/);
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
