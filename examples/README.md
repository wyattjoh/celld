# Examples

These small Wrangler projects demonstrate progressively more of the Worker and
Durable Object surface supported by `celld`:

- `hello/` — a stateless Worker `fetch` handler
- `webapi/` — common Web Platform APIs
- `counter/` — a SQLite-backed Durable Object
- `vectordb/` — nearest-color search with a per-object `vec0` index
- `d1/` — a guestbook on a D1 database
- `async/` — a timer, an outbound fetch, and asynchronous storage
- `body/` — request and response bodies
- `router/` — Worker-to-Durable-Object routing
- `wsecho/` — WebSocket echo with hibernation
- `wsclient/` — outbound WebSocket client from a Durable Object
- `alarm/` — a Durable Object alarm handler
- `cron/` — a cron trigger that writes each tick into a Durable Object
- `rpc/` — JS RPC: Durable Object methods, a named entrypoint, callbacks,
  `RpcTarget`, and promise pipelining
- `agents-conformance/` — pinned, source-unmodified legacy Cloudflare Agents
  SDK routing two named agents, durable state/SQL, hibernating sessions,
  alarm-backed delayed work, a filesystem-only Workspace, and an
  HTTP-streamed AIChatAgent response
- `agents-current-conformance/` — deterministic, credential-free current
  `agents@0.21.0` and `@cloudflare/ai-chat@0.10.2` target for standard named
  routing, multi-event model streaming, durable chat messages, bounded provider
  errors, and state/SQL persistence after inactivity and reconnect
- `wasm/` — a Durable Object counter in Rust, compiled to Wasm with
  [workers-rs](https://github.com/cloudflare/workers-rs); needs a build
  step first (see its [README](wasm/README.md))

Deploy an example from its directory to the same bucket the nodes use:

```sh
celld deploy . --bucket s3://my-cells-bucket
```

They are examples, not the complete compatibility test suite.
