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
  assert.match(harness, /__loader_capability_drop/);
  assert.match(harness, /__loader_capability_target/);
  assert.match(harness, /__loader_load\(JSON\.stringify\(config\), wasm, capabilities\)/);
  assert.match(harness, /if \(prop === "then"\) return undefined/);
  assert.match(harness, /only Workspace fs method calls are supported/);
  assert.match(harness, /__loaderCapabilityFinalizer/);
  assert.match(harness, /nested method proxy keeps the root alive/);
  assert.match(harness, /handle\.token/);
});

test("runtime checks capability identity and denies ambient loaded-worker egress", async () => {
  const runtime = await source("crates/celld/js.rs");
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
  assert.match(runtime, /try_turn/);
  assert.match(runtime, /shutdown_loader_registry/);
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
