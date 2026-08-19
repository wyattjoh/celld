# Agents compatibility conformance

This is the smallest source-unmodified multi-Agent application for celld. It
pins `@cloudflare/agents@0.0.16`, `ai@4.3.19`, and
`@cloudflare/computer@0.2.1`; the exact resolved package integrity values and
complete lockfile digest are recorded in [`compatibility.json`](compatibility.json).
The `ai` version is pinned because the published `AIChatAgent` implementation
uses its `appendResponseMessages` helper.

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
`ConformanceAgent` extends the pinned `AIChatAgent` without changing the SDK.
The HTTP-only seam at `/conformance/chat/<name>` saves the incoming messages,
checkpoints each provider chunk in the owning Agent cell before exposing it,
renews its single-resumer lease while the provider is active, and saves the
assistant message only after the provider stream closes.
Responses carry an `x-celld-response-id`; a caller that disconnects can use
`/conformance/resume/<name>?response=<id>&after=<cursor>` to replay durable
chunks and continue the deterministic provider from its stored cursor after an
Agent eviction/reopen. `/conformance/messages/<name>` uses the inherited
AIChatAgent message reader, so the same conversation is observable after the
lifecycle transition. The WebSocket chat protocol remains reserved for ticket
03.

## Verify the target

```sh
npm ci
npm test
npm run check:compatibility
```

`check:compatibility` fails with stable `[compatibility.*]` error codes if a
pinned package, lockfile integrity, lockfile digest, compatibility setting, or
matrix entry drifts. The Node tests exercise the deterministic provider and
source seam; they do not pretend to be a live celld deployment. The Rust
storage lifecycle test verifies response rows across close/reopen, while the
public-route and ownership-transition evidence requires the deployment steps
below. Updating the target is a deliberate review operation: regenerate the
lockfile, update `compatibility.json` and the matrix together, and rerun the
tests.

## Bundle and deploy

`celld deploy` requires `esbuild` on `PATH`. Use the pinned local binary when
running from this fixture:

```sh
CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild" \
  celld deploy . --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"
```

The model provider double is a separate HTTP capability. Start it before
starting the node that loads the deployment:

```sh
node scripts/model-provider.mjs --port 8788
CELLD_VAR_MODEL_PROVIDER_URL=http://127.0.0.1:8788/v1/chat \
CELLD_AI_URL=http://127.0.0.1:8788/v1/ai \
celld --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"
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
`MODEL_PROVIDER_URL` is injected by the node's deployment capability and is
not in the Worker source. `CELLD_AI_URL` supplies the optional Cloudflare-shaped
`env.AI.run(model, input)` adapter. Provider credentials belong to the
operator-owned HTTP endpoint (or its proxy); this fixture never places a token
in Worker vars, generated code, Workspace contents, or default telemetry.

Then check persistence and streaming through the public listener:

```sh
curl -fsS -N http://127.0.0.1:8080/conformance/chat/alpha \
  -H 'content-type: application/json' \
  -d '{"messages":[{"id":"m1","role":"user","content":"hello"}]}'

curl -fsS http://127.0.0.1:8080/conformance/messages/alpha
# Use the response's x-celld-response-id. Query the durable cursor after a disconnect.
curl -fsS 'http://127.0.0.1:8080/conformance/resume/alpha?response=<response-id>&status=1'
# Then resume after the returned cursor.
curl -fsS -N 'http://127.0.0.1:8080/conformance/resume/alpha?response=<response-id>&after=<cursor>'
curl -fsS -X POST http://127.0.0.1:8080/conformance/ai-adapter/alpha \
  -H 'content-type: application/json' \
  -d '{"messages":[{"id":"m2","role":"user","content":"hello"}]}'
```

The deterministic provider uses an explicit `ndjson-v1` frame sequence over
HTTP; the Agent emits only each frame's text, so transport read coalescing
cannot change the durable cursor. It returns the complete response
`deterministic response for hello`. Interrupt the stream after a chunk, then resume with the
returned response ID and cursor; the resumed body contains the missing suffix
and the completed response is stored in SQLite. After an idle eviction or node
restart, repeat the resume request and `/conformance/messages/alpha`; verify the
same chunks and both user and assistant messages remain. A 30-second lease
is renewed every 10 seconds while a provider fetch/stream is active; if the
heartbeat is lost, the stale stream cannot advance the durable cursor. This
fixture proves
checkpoint-before-exposure and local close/reopen behavior; it does not claim
that a live-fleet output-gate acknowledgement replaces the existing ownership
and replication tests. The adapter endpoint is
an availability check for the Cloudflare-shaped path; the streamed-response
evidence uses ordinary `fetch()` as required by this ticket.

If `MODEL_PROVIDER_URL` is absent, chat returns a `503` with
`missing_deployment_capability` and an actionable message. If the AI binding
is declared but `CELLD_AI_URL` is absent, `env.AI.run()` fails with the same
clear deployment-capability error instead of an undefined binding. Full bucket
restore, ownership-transfer, and output-gate coverage belongs to the live-fleet
runtime harness.

The supported/adapted/unsupported decisions are in
[`compatibility-matrix.md`](compatibility-matrix.md).
