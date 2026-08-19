# Behavioral coverage map

This map is the review gate for retiring the white-box loader-capability and
Worker Shell source assertions. It records the assertion locations as they
existed in the retired tests, the invariant they were trying to protect, and
the behavioral seam that now owns the check. Line numbers refer to the final
white-box revisions before deletion; the regexes are included so a reviewer
can audit that no assertion was silently omitted.

The fixture's live checks are deliberately split by seam:

- **Ticket 02** — capability lifecycle, disposal, and Agent eviction.
- **Ticket 03** — egress policy, tool catalog/invocation, and bounded output.
- **Ticket 04** — admission bounds, timeout, and the structured error wire contract.
- **Ticket 05** — nested modules and the deployed Worker JavaScript seam.
- **Ticket 06** — process-level shutdown drain (the pre-existing shell/workspace
  behavior remains in the ordinary e2e workflow).
- **Ticket 07** — loaded-isolate denial of host-only operation families.
- **Ticket 08** — exact stream ownership for reads, tee, cancel, and response writes.
- **Ticket 09** — host-slot re-entry and concurrent per-Agent data.

## `loader-capability.test.mjs`

All assertions in this file either inspected celld source, sliced source into
`node:vm`, or asserted a source-derived helper. The file is retired in full.
The groups below enumerate every assertion call.

| Former lines | Assertion inventory | Disposition |
| --- | --- | --- |
| 16–29, `Worker Loader uses an explicit capability sideband and opaque proxy` | `/__celldCapability/`; `/__loader_capability_call/`; `/__loader_capability_grant/`; `/__loader_capability_revoke/`; `/__loader_capability_drop/`; `/__loader_capability_target/`; `/__loader_capability_allowlist/`; `/__loader_load\\(\\s*JSON\\.stringify\\(config\\), wasm,/`; `/agentScope/`; `/if \\(prop === "then"\\) return undefined/`; `/Workspace capability only exposes getWorkspace and fs methods/`; `/__loaderCapabilityFinalizer/`; `/nested method proxy keeps the root alive/`; `/handle\\.token/` | **Tickets 02, 03, and 07.** Proxy opacity, capability lifecycle, and host-side grants are now exercised by the deployed lifecycle/eviction, egress/tools/output, and loaded-isolate denial cases. The individual private helper names are implementation details; no text replacement is required. |
| 35–44, `Ticket 06 direct Workspace paths remain compatible with Worker Shell views` | `/const directFsPath = path\\.length === 2 && path\\[0\\] === "fs"/`; `/const shellFsPath = path\\.length === 3/`; `/path\\[0\\] === "getWorkspace" && path\\[1\\] === "fs"/`; `docs: /WORKSPACE\\.fs\\.readFile\\(path, "utf8"\\)/`; `/Workspace capability only exposes getWorkspace and fs methods/`; `/library capability paths must name one method/`; `/attachOutputBytes/`; `/bounded transport size/`; `/__celld\\$loaderCapability/`; `/typeof wrapped\\.js === "string"/` | **Tickets 03, 05, and 07.** Workspace and JavaScript behavior are covered by the deployed shell/JavaScript routes; output truncation is a Ticket 03 response assertion; host-only path denial is Ticket 07. Exact path variables, comments, and the `wrapped.js` representation are text drift with no replacement. |
| 51, 78, 86, `global fetch routes through the explicit broker instead of ambient egress` | VM slice boundary (`start >= 0 && end > start`); `assert.rejects(..., /ambient egress/)`; `response.text() === "broker:https://approved.example"` | **Ticket 03**, replaced by a loaded Worker Fetcher broker: an approved URL succeeds and an unapproved path/origin is denied. The source-slice boundary itself has no replacement. |
| 93, 99–105, `Fetcher broker allowlists are origin-and-path scoped` | VM helper boundary (`start >= 0 && end > start`); policy results: approved exact path `true`, approved child path `true`, `/apix` `false`, other origin `false`, `ftp` `false`, invalid URL `false`, empty allowlist `false` | **Ticket 03**, replaced by the HTTP Code Mode egress step. The policy helper's source extraction boundary is retired with no replacement. |
| 114, 117, 130, `tool catalogs are normalized to host-approved metadata` | VM helper boundary (`catalogStart >= 0 && catalogEnd > catalogStart`); deep-equal normalized catalog containing `name`, `description`, and `inputSchema` but no `secret`; `throws(..., /safe name/)` for `__proto__` | **Ticket 03**, replaced by deployed catalog plus explicit `echo` invocation assertions. The helper slice boundary is text drift; the exact `__proto__` spelling is an implementation-level input check and has no separate replacement. |
| 140, 169, 176, `Agent eviction invalidates named loader workers before reactivation` | VM loader-cache boundary (`start >= 0 && end > start`); stale late load rejects `/Agent scope was evicted/`; reactivation causes `loads === 2` | **Ticket 02**, replaced by the black-box `eviction-prepare` → operator eviction → `eviction-stale` flow. Cache variable names and the VM boundary have no replacement. |
| 182–217, `runtime checks capability identity and denies ambient loaded-worker egress` | `/code_mode_failure\\(/`; `/ErrorKind::HostLost/`; `/capability::authorize/`; `/capability owner mismatch/`; `/capability worker mismatch/`; `/capability kind mismatch/`; `/capability is disposed/`; `/globalOutbound: null/`; `/EgressPolicy::Deny/`; `/random_loader_token/`; `/host_loader_entry/`; `/loaded workers cannot control sibling workers/`; `/HostCellLost/`; `/loader_result_error/`; `/capability_cancel/`; `/worker loader: cancelled/`; `/worker loader: timed_out/`; driver `/worker loader: host_cell_lost/`; `/try_turn/`; `/shutdown_loader_registry/`; `/capability grants require a host isolate/`; `/CapabilityKind::Library/`; `/CapabilityKind::Fetcher/`; `/CapabilityKind::Tools/`; `/with_main_module\\(main\\.to_string\\(\\)\\)/`; `/register_main_module/`; `/Fetcher brokers require a non-empty allowlist/`; `/globalOutbound must be an explicit Fetcher broker/`; `/loader_capability_allowlist/`; `/loaded workers cannot invoke worker stubs/`; `/worker stub Agent scope mismatch/`; `/HOST_ONLY/`; `/evict_loader_agent/`; `/struct StreamOwner/`; `/response stream owner mismatch/`; `/current_stream_owner/` | **Tickets 02–09 as follows:** Host-lost/disposed and timeout classes are Tickets 02 and 04; allowlist and explicit broker behavior is Ticket 03; host-only and capability identity denials are Ticket 07; stream ownership is Ticket 08; `try_turn`/host-isolate loss and shutdown registry behavior are Tickets 06 and 09. Private function/type names, comments, and registration calls are pure text drift with no replacement. |
| 224–231, `loaded Workers replace raw host authority ops` | Source-list boundary (`start >= 0 && end > start`); host-only names `__svc_call`, `__svc_rpc`, `__do_call`, `__rpc_call`, `__storage_get`, `__storage_put`, `__sql_exec`, `__alarm_set`, `__loader_fetch`, `__loader_rpc`, `__loader_drop` | **Ticket 07**, replaced by one real loaded-isolate V8 test that calls each host-only family and asserts bounded denial results. The `HOST_ONLY` array and list-extraction source mechanics have no replacement. |
| 237–241, `normal Workers retain inherited outbound behavior while brokers stay explicit` | `/config\\.globalOutbound !== undefined && config\\.globalOutbound !== null/`; `/delete config\\.globalOutbound/`; `/__loaderOutbound !== null/`; `/process-global stream ids never become loaded-worker\\s+\\/\\/\\s+authority handles/`; Rust `/None => actor_runtime_state\\(scope\\)\\.egress/` | **Ticket 03**, replaced by approved Fetcher success plus ambient-egress denial in the deployed loaded worker. The exact cleanup branch and explanatory comment are text drift with no replacement. |
| 247–272, `host env injection materializes only opaque loaded-worker proxies` | Harness `/code_mode\\.disposed/`; `/retryable = false/`; bootstrap `/__makeLoaderCapability/`; `/__setLoaderOutbound/`; `/loader_capabilities/`; harness `/__clearLoaderAgent/`; `/byName.delete/`; `/agentGenerations/`; `/Agent scope was evicted/`; runtime `/clear_loader_agent/`; `/buffer_streams: true/`; harness `/__bufferRpcStreams/`; `/__celld\\$bufferedStream/`; runtime `/worker loader: host internal operation is unavailable/`; `/CapabilityKind::Tools/`; `/release_loader_capabilities/`; `/release_loader_entry/`; `/in-flight calls settle/`; `/revoke_loader_entries_for_scope/`; `/wait_idle_bounded/`; bootstrap `/loaded module is untrusted/`; `/delete globalThis.__makeLoaderCapability/`; runtime `/op_loader_capability_grant/`; `/op_loader_capability_revoke/`; `/\\.remove\\(&token\\)/` | **Tickets 02, 03, 07, and 08.** Disposal/revocation and bounded stream transport are covered behaviorally by Tickets 02, 03, and 08; loaded-isolate authority denial is Ticket 07. The bootstrap helper names and cleanup implementation phrases are pure text drift with no replacement. |
| 281–283, `capability interruption classes and clone-only transport are explicit` | Logic names `cancelled`, `timed_out`, `isolate_failure`, `capability_failure`, `host_cell_lost`, `worker_disposed`; docs `/byte-shaped result streams are buffered/`; `/losing ownership/` | **Tickets 02, 04, 06, and 08.** The public e2e responses assert stable class/code and retryability; Rust tests assert ownership denial and loaded transport behavior. The list of enum spellings and prose snippets are not independently preserved as source checks. |
| 288–297, `the pinned Worker JavaScript fixture uses only the explicit library bridge` | Fixture `/@cloudflare\\/computer\\/backends\\/worker-javascript/`; `/new WorkerJavaScriptBackend/`; `/loader\\.capability\\("library", library\\)/`; `/node:fs\\/promises/`; `/DEFAULT_JAVASCRIPT_SOURCE/`; `/LOADER_MODULE_SOURCE/`; `/add\\.wasm/`; `/workspace\\/nested\\/loader-helper\\.js/`; `/operation === "loader-modules"/`; `/\\/conformance\\/javascript\\//` | **Ticket 05**, replaced by the deployed Worker JavaScript step, including the named nested sibling and Wasm result. Import paths and constant names are source-shape checks with no replacement. |
| 303–307, `Worker JavaScript failure paths stay bounded and no-egress` | Fixture `/operation === "cancel"/`; `/status: result\\.status/`; README `/CELLD_WORKER_LOADER=LOADER/`; `/non-JSON/`; `/no\\s+ambient network access/` | **Ticket 05**, replaced by deployed cancellation, structured result, and no-ambient-egress behavior. Documentation wording checks are retired text drift. |
| 314–334, `Code Mode admission bounds are distinct and pressure preserves cell authority` | Logic `/CodeSize/`; `/EnvSize/`; `/WorkerLimit/`; `/ConcurrencyLimit/`; `/MemoryLimit/`; `/Pressured/`; `/ErrorKind/`; `/CapabilityUnknown/`; `/retryable/`; runtime `/loader_throw_code/`; `/throw_capability_error/`; `/retryable_key/`; `/CELLD_MAX_LOADED_WORKER_CONCURRENCY/`; `/CELLD_LOADED_WORKER_TIMEOUT_S/`; `/memory admission limit exceeded/`; `/pressure shedding rejects new Code Mode work/`; `/revoke_loader_capabilities_for_cell/`; `/EXECUTION_TIMEOUT_WIRE_ERROR/`; `/drive_loaded_worker/`; main `/set_code_mode_pressure/`; `/authoritative Workspace state remain/` | **Ticket 04**, replaced by oversized code/env and bounded-timeout HTTP probes asserting `code_mode.*` and `retryable`. Runtime pressure/limit implementation names are text drift; no source assertion is retained. |

## `worker-shell.test.mjs`

The first test's source and harness assertions were the remaining Worker Shell
white-box checks. They are removed; the tests beginning with
`WorkerShellBackend loads ShellWorker...` remain and execute the pinned package
and filesystem behavior.

| Former lines | Assertion inventory | Disposition |
| --- | --- | --- |
| 151 | `packageData.dependencies["just-bash"] === "3.4.0"` | **Retained as a package-pin check** (not runtime source inspection), also enforced by `check:compatibility`. |
| 152–158 | Source regexes `/WorkerShellBackend/`, `/egress: \\{ mode: "none" \\}/`, `/backend: "worker-shell"/`, `/workspace\\.runtime\\.exec\\(command,/`, `/unsupported_command/`, `/timed_out/`, `/WorkspaceServiceProxy/` | **Ticket 05**, replaced by the deployed Worker Shell route and retained package/bundling tests. These source-text assertions are deleted. |
| 159–165 | Harness regexes `/__celld\\$loaderCapability/`, `/service\\?\\.name === "WorkspaceServiceProxy"/`, `/path\\.length === 0 \\? drop/`, `/workspaceView\\?\\.\\[Symbol\\.dispose\\]/`, `/capabilityDescriptor\\(value, name\\)/`, `/Workspace capability only exposes getWorkspace and fs methods/`, `/globalThis\\.\\__loaderWorkerId/` | **Tickets 05 and 07**, replaced by the deployed shell/Workspace operation and loaded-isolate denial tests. The private helper names and cleanup syntax have no replacement. |
| 166–167 | Matrix regexes `/just-bash@3\\.4\\.0/`, `/Worker Shell backend.*adapted/` | **Retained as compatibility documentation checks**; these do not inspect runtime source. |
| 168 | Source negative regex `/shell\\/(?:curl|python|sqlite|js-exec)/` | **Ticket 05**, replaced by the deployed unsupported-command and no-egress shell cases; deleted as source inspection. |
| 189–351 | Remaining loader/package/Workspace behavioral assertions (entrypoint/config props, shared Workspace writes, unsupported command, denied network, interruption/timeout) | **Retained.** They already execute the pinned package and are not source-text assertions. The deployed e2e runner adds the same public Worker Shell path. |

## Retired text-only checks

The following categories are intentionally not mapped to a new assertion:

- private Rust/JavaScript function, variable, and operation names;
- source slice boundaries and VM evaluation of a copied implementation;
- comments, error-message literals that are not public wire contracts, and
  documentation wording;
- the exact shape of the `HOST_ONLY` list or bootstrap cleanup code;
- package compatibility prose already protected by the package/matrix and
  lockfile checks.

A future implementation may rename or reorganize these details without
requiring a test update. Public behavior remains pinned by the HTTP e2e steps
and the in-crate loaded-isolate/stream/slot tests listed above.
