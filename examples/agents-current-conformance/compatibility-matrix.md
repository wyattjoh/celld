# Current Agents SDK compatibility matrix

This target is intentionally separate from the legacy
`@cloudflare/agents@0.0.16` fixture. It imports the published unscoped
`agents@0.21.0` package without source changes or copied SDK internals.

| Surface | Evidence | Status | celld decision |
| --- | --- | --- | --- |
| `agents@0.21.0` `Agent` class and SQLite Durable Object registration | `CurrentConformanceAgent` is exported and bound as a SQLite Durable Object | adapted | celld supplies the Durable Object lifecycle and per-cell SQLite storage |
| `agents@0.21.0` `getAgentByName` | `/current/names` resolves `alpha` and `beta` through the declared namespace | supported | named stubs use the standard public Worker RPC boundary |
| `agents@0.21.0` `routeAgentRequest` HTTP routing | `/agents/current-conformance-agent/alpha/status` and `beta/status` | adapted | celld preserves the current SDK route shape and forwards the request to the named cell |
| `agents@0.21.0` `routeAgentRequest` WebSocket routing | `/agents/current-conformance-agent/<name>` sends `connected` and `message` frames | adapted | celld owns the host WebSocket while the current Agent hooks run on activation |
| Agent state and SQL persistence | `/current/state/<name>` survives idle eviction and reopen | adapted | `setState` and `this.sql` use the owning cell's authoritative SQLite database |
| Reviewed dependency set | `agents@0.21.0`, `zod@4.4.3`, and `esbuild@0.28.2` are checked against the lockfile integrity and digest | supported | the target is reproducible without Strix, Tailscale, or credentials |
| current SDK facets, MCP, AI chat, and tool integrations | not used by this minimal target | unsupported | outside this ticket; add a separate target only when a public celld seam is specified |

`adapted` means the published SDK code runs unchanged while celld supplies a
Durable Object/runtime boundary. It does not mean unsupported SDK features are
silently emulated.
