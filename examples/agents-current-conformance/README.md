# Current Agents SDK conformance

This is a deterministic, credential-free tracer for the current published
`agents@0.21.0` SDK. It is deliberately separate from
[`../agents-conformance`](../agents-conformance/), which preserves the legacy
`@cloudflare/agents@0.0.16` target and its existing test contract.

The Worker imports the published package directly, extends its public `Agent`
class, resolves two named Agents with `getAgentByName`, and delegates the
standard HTTP/WebSocket surface to `routeAgentRequest`. It does not copy SDK
internals, patch package files, contact Strix, or require Tailscale.

## Verify the target

```sh
npm ci --no-audit --no-fund
npm test
npm run check:compatibility
```

The lockfile records the reviewed peer lane required for bundling the current
SDK. `compatibility.json` records every direct package integrity and the full
lockfile SHA-256. Updating the SDK is a deliberate compatibility review:
regenerate the lockfile, update the matrix and digest together, and rerun the
bundle and tests.

## Public contract

The deterministic Worker routes these public endpoints:

- `GET /current/names` resolves `alpha` and `beta` through
  `getAgentByName`.
- `GET /current/state/<name>` reads the named Agent's state and SQL records.
- `POST /current/state/<name>` writes a deterministic value/revision pair.
- `GET /agents/current-conformance-agent/<name>/status` exercises the current
  SDK's standard HTTP routing helper.
- `ws://.../agents/current-conformance-agent/<name>` exercises the current
  SDK's standard WebSocket routing helper. The Agent emits
  `current-conformance.connected` and `current-conformance.message` frames.

Each name has an independent Durable Object cell. The state and event rows are
read again after configured idle eviction to prove that inactivity/reopen does
not mix names or lose durable records.

## Bundle and deploy

`celld deploy` needs the pinned local esbuild binary and a bucket:

```sh
CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild" \
  celld deploy . --bucket "$CELLD_BUCKET" \
  --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"
```

Start celld with the deployment loaded, then run the dependency-free public
contract runner:

```sh
CELLD_BUCKET=s3://celld \
CELLD_ADDR=127.0.0.1:8080 \
CELLD_INTERNAL_ADDR=127.0.0.1:8081 \
CELLD_IDLE_EVICT_S=1 \
CELLD_WATCH=/tmp/celld-current-state \
celld --bucket s3://celld --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"

CELLD_URL=http://127.0.0.1:8080 \
CELLD_IDLE_EVICT_S=1 \
npm run e2e
```

The e2e runner checks readiness, both named HTTP routes, isolated state/SQL,
the standard WebSocket route, and a configured idle eviction/reopen for both
names. The Agent's activation counter makes the reopen observable while all
normal checks use the public listener; no private operator endpoint is needed.

The current SDK dependency graph contains a legacy bare `path` import in an
unused MIME/email lane. celld keeps that Node builtin external during bundling
and resolves it through the same builtin registry as `node:path`; no host
filesystem or Node process capability is granted to the Worker. The initial
supported/adapted/unsupported decisions are recorded in
[`compatibility-matrix.md`](compatibility-matrix.md).
