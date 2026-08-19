# Agents compatibility conformance

This is the smallest source-unmodified multi-Agent application for celld. It
pins `@cloudflare/agents@0.0.16` and `@cloudflare/computer@0.2.1`; the exact
resolved package integrity values and complete lockfile digest are recorded in
[`compatibility.json`](compatibility.json).

The fixture declares one `ConformanceAgent` Durable Object class and addresses
stable names `alpha` and `beta` in the same deployment. Its callable
`conformance({ name })` method returns only structured-cloneable data.
`routeAgentRequest` is also exercised at the standard Agent path:
`/agents/agents/<name>`. The state/SQL path writes and reads one state value
and one SQL row per name at `/conformance/state/<name>`; the response exposes
both surfaces so deterministic checks can verify that `alpha` and `beta` never
share rows.

Full bucket restore, ownership-transfer, and output-gate coverage belongs to
the live-fleet runtime harness.

The Agent also exercises the pinned hibernating `Server` surface. A text
message received on `/agents/agents/<name>` increments durable session state
and an event row in the owning Agent's SQL database, so a cell can be evicted
while the host WebSocket remains open and the next message wakes a fresh instance. `/conformance/session/<name>`
reports that state and event log. `/conformance/schedule/<name>` exposes the
numeric-delay form of `Agent.schedule()`; its `recordScheduledWork` callback
updates durable state and the schedule-run table. This deliberately uses
celld's Durable Object alarm path, not a Worker cron trigger.

The Agent also uses the pinned filesystem-only Computer seam:
`withWorkspace(Agent, (self) => ({ storage: self.ctx.storage }))`. The
Workspace has no execution backend, and its `fs` surface is exercised through
`POST /conformance/workspace/<name>` with an operation of `create`, `read`,
`update`, `list`, `search`, or `delete`. The package's VFS tables therefore
live in the owning Agent cell's authoritative SQLite database, not in a second
store. With the default `CELLD_OUTPUT_GATE=1`, the host withholds a successful
mutating response until the cell's configured durability path proves the
SQLite write position; `CELLD_OUTPUT_GATE=0` explicitly opts out of that
acknowledgment guarantee.

The focused package/runtime fixture test covers all six operations, reopen
persistence, and alpha/beta isolation. It does not claim a live bucket restore,
ownership-transfer, or multi-node fleet result; those remain live-fleet
coverage rather than evidence inferred from this local seam.

The commands below are deployed conformance procedures. The npm tests are
contract checks and the storage tests prove alarm and Workspace persistence
after close and reopen; they do not claim a live multi-node takeover or
output-gate timing run without the operator supplying a bucket and fleet.

## Verify the target

```sh
npm ci
npm test
npm run check:compatibility
```

`check:compatibility` fails with stable `[compatibility.*]` error codes if a
pinned package, lockfile integrity, lockfile digest, compatibility setting, or
matrix entry drifts. Updating the target is a deliberate review operation:
regenerate the lockfile, update `compatibility.json` and the matrix together,
and rerun the tests.

## Bundle and deploy

`celld deploy` requires `esbuild` on `PATH`. Use the pinned local binary when
running from this fixture:

```sh
CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild" \
  celld deploy . --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"
```

Start or restart celld against the same bucket, then check the public listener:

```sh
curl -fsS http://127.0.0.1:8080/conformance/call/alpha
curl -fsS http://127.0.0.1:8080/conformance/call/beta
curl -fsS http://127.0.0.1:8080/conformance/names
curl -fsS -X POST http://127.0.0.1:8080/conformance/state/alpha \
  -H 'content-type: application/json' -d '{"value":"alpha-state","revision":1}'
curl -fsS -X POST http://127.0.0.1:8080/conformance/state/beta \
  -H 'content-type: application/json' -d '{"value":"beta-state","revision":1}'
curl -fsS http://127.0.0.1:8080/conformance/state/alpha
curl -fsS http://127.0.0.1:8080/conformance/state/beta
curl -fsS http://127.0.0.1:8080/agents/agents/alpha
curl -fsS http://127.0.0.1:8080/agents/agents/beta
```

### Hibernating session procedure

Use `websocat` (or another WebSocket client) against the public listener:

```sh
websocat ws://127.0.0.1:8080/agents/agents/alpha
# send: {"message":"before-eviction"}
```

The response includes `messageCount` and `connectionId`. Capture the
connection ID, close the client, and reconnect to the same Agent path. The
second connection receives the already-incremented durable state. To exercise
hibernation with the first socket still open, send a message, then ask the
private operator listener to evict the named cell using the address printed at
startup:

```sh
curl -fsS -X POST http://127.0.0.1:8081/evict/ConformanceAgent:alpha
# send on the still-open WebSocket: {"message":"after-eviction"}
curl -fsS http://127.0.0.1:8080/conformance/session/alpha
```

The open socket remains host-owned while the cell is inactive; the next
message activates the cell and the event log must continue at the next
`messageCount`. The internal listener is unauthenticated and must remain
private; its port may be ephemeral, so replace `8081` with the startup value.

### Durable Agent schedule procedure

For this short-delay eviction check, start the node with
`CELLD_ALARM_RESIDENT_MS=0`. The default near-alarm residency window keeps an
imminent alarm resident, so an operator eviction is expected to wait instead of
testing an inactive wake. Then schedule delayed work, evict the now-idle cell,
and inspect the callback result:

```sh
curl -fsS -X POST http://127.0.0.1:8080/conformance/schedule/alpha \
  -H 'content-type: application/json' \
  -d '{"delaySeconds":2,"payload":{"job":"wake"}}'
curl --max-time 10 -fsS -X POST http://127.0.0.1:8081/evict/ConformanceAgent:alpha
node -e 'setTimeout(() => {}, 3000)'
curl --max-time 10 -fsS http://127.0.0.1:8080/conformance/schedule/alpha
```

The final response must show `scheduledRuns` incremented and the payload in
`runs`. This is a one-shot delayed schedule backed by `storage.setAlarm()`;
the fixture intentionally does not use a cron trigger. A bucket-backed
restart or ownership-transfer run should additionally verify the same response
on the replacement node; that fleet evidence is not produced by `npm test`.

The two callable responses contain `agent: "alpha"` and `agent: "beta"`
respectively. State reads return the selected Agent state and only that Agent's
SQL row after local activation and reopen. The route responses identify
`surface: "routeAgentRequest"`. The supported/adapted/unsupported decisions are
in [`compatibility-matrix.md`](compatibility-matrix.md).
