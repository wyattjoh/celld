# Agents compatibility target

This fixture is the pinned, source-unmodified compatibility seam extended through tickets 02, 03, 04, 05, 08, and 09.
The package versions, lockfile integrity values, and lockfile digest are checked
by `npm run check:compatibility`; changing an upstream version without a
reviewed target update fails before deployment.

## Pinned target

| input | value |
| --- | --- |
| Agents SDK | `@cloudflare/agents@0.0.16` |
| AI SDK helper | `ai@4.3.19` |
| schema helper | `zod@3.25.76` |
| Computer SDK | `@cloudflare/computer@0.2.1` |
| bundler | `esbuild@0.28.2` |
| compatibility date | `2026-01-01` |
| compatibility flags | `js_rpc` |

## Initial matrix

The status describes the celld contract at this fixture seam:

- **supported** — the fixture exercises the surface without an application
  patch and observes the expected result.
- **adapted** — the source contract is unchanged, but celld supplies an
  explicitly documented Durable Object/runtime mapping at the boundary.
- **unsupported** — the package is pinned for the target, but this surface is
  intentionally rejected or deferred to a later ticket; it must not be
  inferred from the package being installed.

| package and surface | fixture exercise | status | evidence / boundary |
| --- | --- | --- | --- |
| `@cloudflare/agents@0.0.16` `Agent` class and DO registration | `ConformanceAgent` extends `AIChatAgent` (which extends `Agent`) and deploys with a SQLite migration | adapted | celld maps the Cloudflare Durable Object base and SQLite storage to a named cell |
| `@cloudflare/agents@0.0.16` `AIChatAgent` message persistence | inherited message table is read through `/conformance/messages/<name>`; HTTP chat writes the same table | adapted | the SDK class is imported unmodified; the fixture's HTTP seam duplicates only the private persistence call needed outside the WebSocket protocol |
| celld durable response cursor | each framed `ndjson-v1` provider chunk is stored in `conformance_ai_response_chunks`; `/conformance/resume/<name>` reports the cursor, replays, and continues after an eviction/reopen | adapted | the cursor is explicit provider frame sequence, response IDs hash canonical messages, and a 30-second lease renews every 10 seconds while active; the provider double honors `x-celld-resume-after`; live-fleet takeover/output-gate timing remains an operational test |
| `@cloudflare/agents@0.0.16` `getAgentByName` | calls both `alpha` and `beta` | supported | each name is resolved through the declared `agents` Durable Object namespace |
| `@cloudflare/agents@0.0.16` structured-cloneable callable method | `conformance({ name })` returns nested arrays and objects | supported | no function, stream, class, or live RPC capability crosses the cell boundary |
| `@cloudflare/agents@0.0.16` `routeAgentRequest` | `/agents/agents/alpha`, `/agents/agents/beta`, and HTTP chat paths | adapted | PartyServer routing is source-unmodified; celld supplies namespace, dispatch, and streaming response bodies |
| `@cloudflare/agents@0.0.16` state and embedded SQL | `/conformance/state/alpha` and `/conformance/state/beta` write/read independently | adapted | the fixture uses celld's private per-cell SQLite path; deterministic reopen coverage is present, while bucket restore, ownership-transfer, and output-gate evidence remain runtime-test work |
| `@cloudflare/agents@0.0.16` hibernating WebSockets and durable session state | `/agents/agents/<name>` `onConnect`/`onMessage`, `/conformance/session/<name>`, deployed eviction procedure | adapted | celld keeps the host socket and attachment metadata while the named cell is inactive; session state and event rows remain in that Agent cell's SQLite database |
| `@cloudflare/agents@0.0.16` delayed `schedule()` and alarm callback | `/conformance/schedule/<name>` plus deployed eviction procedure | adapted | numeric-delay schedules call `storage.setAlarm()` and wake the inactive named cell; Worker cron is not implied |
| `@cloudflare/computer@0.2.1` filesystem-only Workspace | `ConformanceAgent.workspace` exercises create/read/update/list/search/delete | adapted | `withWorkspace` passes the owning Agent's `ctx.storage`; focused package/runtime tests cover reopen persistence and alpha/beta isolation; live bucket lifecycle is not claimed |
| celld ordinary outbound `fetch()` and HTTP response streams | deterministic framed provider chunks pass through `/conformance/chat/<name>` | adapted | outbound HTTP and `CelldHttpBodyStream` provide transport; resumability uses explicit `ndjson-v1` framing plus a renewed single-resumer lease |
| celld HTTP AI adapter (`ai` binding + `CELLD_AI_URL`) | `/conformance/ai-adapter/<name>` calls `env.AI.run(model, input)` | adapted | celld maps the declared binding to an operator-owned HTTP endpoint and fails clearly when the endpoint capability is absent |
| deployment credential isolation | provider URL/token is not in `index.js`, Worker vars, Workspace files, or default telemetry | adapted | provider authentication belongs to the operator-owned HTTP endpoint; this credential-free double tests transport only |
| public deployment/lifecycle route | README curl flow covers chat, status, resume, and messages after a node transition | adapted | this worktree has no live bucket/node credentials; Node tests and Rust storage tests are bounded local evidence, so a live deployment run is still required for end-to-end acceptance |
| `@cloudflare/computer@0.2.1` Worker JavaScript backend | `/conformance/javascript/<name>` runs a structured module in a fresh loaded worker, imports a Workspace sibling, and reads a Workspace file through `node:fs/promises` | adapted | celld grants one explicit `library` capability for the pinned bridge; generated code has no ambient egress; bounded framed stdio is forwarded as bytes rather than as a live stream; cancellation, isolate failure, and non-JSON results are bounded outcomes |
| `@cloudflare/computer@0.2.1` Worker Shell backend | `/conformance/shell/<name>` runs pinned core commands in a loaded worker | adapted | `WorkerShellBackend` is source-unmodified; celld grants only the Workspace fs sideband and forces `globalOutbound: null`; shell state stays in the Agent cell |
| `just-bash@3.4.0` core Worker Shell runtime | `mkdir`, redirection, `cat`, `grep`, and unsupported-command/timeout outcomes | supported | the exact package is a direct fixture dependency and lockfile target; no optional Python, SQLite, or JS-exec groups are bundled, and core `curl` is denied by `globalOutbound: null` |
| `@cloudflare/computer@0.2.1` container backend, R2, and Artifacts | not exercised by this ticket | unsupported | no Linux/container or object-store emulation is implied |
| `esbuild@0.28.2` Worker bundling | `celld deploy` bundles `index.js` and accepts the `ai` binding | adapted | celld's deploy allowlist records the AI binding while the endpoint remains node deployment configuration |
