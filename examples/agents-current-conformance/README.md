# Current Agents SDK and AI chat conformance

This credential-free target runs the current published `agents@0.21.0` and
`@cloudflare/ai-chat@0.10.2` packages. It is deliberately separate from
[`../agents-conformance`](../agents-conformance/), which preserves the legacy
`@cloudflare/agents@0.0.16` contract.

The Worker imports published packages directly, extends `AIChatAgent`, resolves
two named Agents with `getAgentByName`, and delegates all public Agent HTTP and
WebSocket traffic to `routeAgentRequest`. It uses `ai@6.0.259` and
`@ai-sdk/openai@3.0.98` to stream `llama-swap/Qwen3.6-35B-A3B` through a
credential-free OpenAI-compatible gateway URL. It does not copy SDK internals,
patch package files, contact Strix, or require a bearer token.

## Verify the target

```sh
npm ci --no-audit --no-fund
npm test
npm run check:compatibility
```

The lockfile records every reviewed direct package integrity.
`compatibility.json` records those values and the full lockfile SHA-256.
Updating any package requires regenerating the lockfile and updating the matrix
and digest together.

## Public contract

The deterministic Worker exposes only the current Agent routing surface plus
small tracer endpoints:

- `GET /current/names` resolves `alpha` and `beta` with `getAgentByName`.
- `GET|POST /current/state/<name>` verifies isolated Agent state and SQL.
- `POST /current/memories/reset` clears both named memory fixtures before a repeatable run.
- `POST /current/reminders/reset` cancels and clears both named reminder fixtures before a repeatable run.
- `GET /agents/current-conformance-agent/<name>/status` exercises standard
  Agent HTTP routing.
- `GET /agents/current-conformance-agent/<name>/get-messages` is the
  `AIChatAgent` transcript read surface.
- `ws://.../agents/current-conformance-agent/<name>` carries both ordinary
  Agent frames and the standard `AIChatAgent` chat protocol.

A deterministic OpenAI-compatible provider emits three separate text deltas before completing `Deterministic streamed response.` It also emits controlled memory and reminder tool calls. Strict Zod-backed server tools retain bounded explicit facts and reminder metadata in application SQL separate from chat transport messages. Reminder tools use idempotent Agent schedules, reject invalid delays, messages, identifiers, and cross-Agent cancellation attempts, and retain pending, cancelled, and completed state. The public runner proves same-Agent completion broadcasts, alarm wake-up after inactivity, named isolation, and durable reads through public Agent routes. Tests do not inspect package-private SQLite tables.

The provider double also produces rejection, malformed stream, and connection
failures. Together with a missing-capability request, these prove stable public
codes without returning upstream response bodies, URLs, stack traces, or
credentials:

- `chat_provider_capability_missing`
- `chat_provider_unavailable`
- `chat_provider_rejected`
- `chat_provider_invalid_output`

## Compose conformance

From the repository root, select this fixture while retaining the legacy suite
as the default:

```sh
CELLD_CONFORMANCE_FIXTURE=agents-current-conformance \
CELLD_IDLE_EVICT_S=1 \
docker compose up -d --build minio minio-init model-provider deployer celld

CELLD_CONFORMANCE_FIXTURE=agents-current-conformance \
CELLD_IDLE_EVICT_S=1 \
docker compose --profile test run --rm e2e
```

The Compose provider is deterministic and secret-free. The E2E runner schedules, lists, deduplicates, cancels, and completes alarm-backed reminders in addition to the chat and memory checks. celld receives only
`MODEL_GATEWAY_URL=http://model-provider:8788` and the reviewed model name.
A real Strix deployment supplies the same OpenAI chat-completions shape through
the separately credentialed internal gateway owned by the demo repository.

The current SDK dependency graph contains a legacy bare `path` import in an
unused MIME/email lane. celld keeps that Node builtin external during bundling
and resolves it through the same builtin registry as `node:path`; no host
filesystem or Node process capability is granted to the Worker. Detailed
supported, adapted, and unsupported decisions are in
[`compatibility-matrix.md`](compatibility-matrix.md).
