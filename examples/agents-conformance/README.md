# Agents compatibility conformance

This is the smallest source-unmodified multi-Agent application for celld. It
pins `@cloudflare/agents@0.0.16` and `@cloudflare/computer@0.2.1`; the exact
resolved package integrity values and complete lockfile digest are recorded in
[`compatibility.json`](compatibility.json).

The fixture declares one `ConformanceAgent` Durable Object class and addresses
stable names `alpha` and `beta` in the same deployment. Its callable
`conformance({ name })` method returns only structured-cloneable data.
`routeAgentRequest` is also exercised at the standard Agent path:
`/agents/agents/<name>`.

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
curl -fsS http://127.0.0.1:8080/agents/agents/alpha
curl -fsS http://127.0.0.1:8080/agents/agents/beta
```

The two callable responses contain `agent: "alpha"` and `agent: "beta"`
respectively. The route responses identify `surface: "routeAgentRequest"`.
The initial supported/adapted/unsupported decisions are in
[`compatibility-matrix.md`](compatibility-matrix.md).
