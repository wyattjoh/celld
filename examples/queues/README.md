# Queues example

This Worker uses one `EVENTS` producer binding and one same-script push consumer. The consumer records each delivery in the `Deliveries` Durable Object because `fetch()` and `queue()` run in separate isolates.

The handler demonstrates three message-driven outcomes:

- `{ "mode": "ack" }` calls `ack()` immediately.
- `{ "mode": "retry", "until": 2 }` retries the first attempt and acknowledges the second.
- `{ "mode": "poison" }` always retries and is dropped after the configured retry ceiling.

The one-second batch timeout and retry delay, batch size of 10, and two retries are intentionally lower than Cloudflare's defaults. They exercise real batching and alarm-driven redelivery while keeping the example's end-to-end run short.

Run the dependency-free contract tests:

```sh
npm test
```

Run the three live scenarios in a fresh Compose lab without changing `compose.yaml`:

```sh
CELLD_CONFORMANCE_FIXTURE=queues docker compose --profile test run --rm e2e
CELLD_CONFORMANCE_FIXTURE=queues docker compose down --volumes --remove-orphans
```

The live run proves `send()` and `sendBatch()` delivery and deserialization, selective retry without redelivering acknowledged siblings, and poison-message drop after three attempts followed by a five-second quiet window.
