# Agents compatibility target

This fixture is the pinned, source-unmodified compatibility seam extended through ticket 03.
The package versions, lockfile integrity values, and lockfile digest are checked
by `npm run check:compatibility`; changing an upstream version without a
reviewed target update fails before deployment.

## Pinned target

| input | value |
| --- | --- |
| Agents SDK | `@cloudflare/agents@0.0.16` |
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
| `@cloudflare/agents@0.0.16` `Agent` class and DO registration | `ConformanceAgent` extends `Agent` and deploys with a SQLite migration | adapted | celld maps the Cloudflare Durable Object base and SQLite storage to a named cell |
| `@cloudflare/agents@0.0.16` `getAgentByName` | calls both `alpha` and `beta` | supported | each name is resolved through the declared `agents` Durable Object namespace |
| `@cloudflare/agents@0.0.16` structured-cloneable callable method | `conformance({ name })` returns nested arrays and objects | supported | no function, stream, class, or live RPC capability crosses the cell boundary |
| `@cloudflare/agents@0.0.16` `routeAgentRequest` | `/agents/agents/alpha` and `/agents/agents/beta` | adapted | PartyServer routing is source-unmodified; celld supplies the namespace and request dispatch |
| `@cloudflare/agents@0.0.16` state and embedded SQL | `/conformance/state/alpha` and `/conformance/state/beta` write/read independently | adapted | the fixture uses celld's private per-cell SQLite path; deterministic reopen coverage is present, while bucket restore, ownership-transfer, and output-gate evidence remain runtime-test work |
| `@cloudflare/agents@0.0.16` hibernating WebSockets and durable session state | `/agents/agents/<name>` `onConnect`/`onMessage`, `/conformance/session/<name>`, deployed eviction procedure | adapted | celld keeps the host socket and attachment metadata while the named cell is inactive; Agent state and session rows remain in that cell's SQLite database |
| `@cloudflare/agents@0.0.16` delayed `schedule()` and alarm callback | `/conformance/schedule/<name>` plus deployed eviction procedure | adapted | numeric-delay schedules call `storage.setAlarm()` and wake the inactive named cell; Worker cron is not implied |
| `@cloudflare/computer@0.2.1` filesystem-only Workspace | not exercised by this ticket | unsupported | durable Workspace integration is ticket 05 |
| `@cloudflare/computer@0.2.1` Worker JavaScript backend | not exercised by this ticket | unsupported | loader capability integration is ticket 08 |
| `@cloudflare/computer@0.2.1` Worker Shell backend | not exercised by this ticket | unsupported | loader capability integration is ticket 09 |
| `@cloudflare/computer@0.2.1` container backend, R2, and Artifacts | not exercised by this ticket | unsupported | no Linux/container or object-store emulation is implied |
| `esbuild@0.28.2` Worker bundling | `celld deploy` bundles `index.js` | supported | the fixture uses the same `celld deploy` path as the other examples |
