# Current Agents SDK compatibility matrix

This target is intentionally separate from the legacy
`@cloudflare/agents@0.0.16` fixture. It imports the published unscoped
`agents@0.21.0` and `@cloudflare/ai-chat@0.10.2` packages without source
changes or copied SDK internals.

| Surface | Evidence | Status | celld decision |
| --- | --- | --- | --- |
| `agents@0.21.0` `Agent` class and SQLite Durable Object registration | `CurrentConformanceAgent` is exported and bound as a SQLite Durable Object | adapted | celld supplies the Durable Object lifecycle and per-cell SQLite storage |
| `agents@0.21.0` `getAgentByName` | `/current/names` resolves `alpha` and `beta` through the declared namespace | supported | named stubs use the standard public Worker RPC boundary |
| `agents@0.21.0` `routeAgentRequest` HTTP routing | `/agents/current-conformance-agent/alpha/status` and `beta/status` | adapted | celld preserves the current SDK route shape and forwards the request to the named cell |
| `agents@0.21.0` `routeAgentRequest` WebSocket routing | `/agents/current-conformance-agent/<name>` carries Agent and chat protocol frames | adapted | celld owns the host WebSocket while the published Agent hooks run on activation |
| `@cloudflare/ai-chat@0.10.2` `AIChatAgent` | a standard chat request emits multiple UI message stream frames and completes one assistant turn | adapted | the source-unmodified package runs on celld's WebSocket, stream, alarm, and SQLite boundaries |
| Durable chat messages | `get-messages` returns the same completed user and assistant messages after all clients disconnect and later reconnect | adapted | the package-owned durable message model remains authoritative; the fixture does not copy or inspect its private tables |
| Interrupted-stream resumption | a client disconnects after the known first chunk, two concurrent resumers (including a stale acknowledgement) reconcile the exact completed text, and `get-messages` exposes one assistant message; a terminal provider disconnect settles that message with a bounded failure | adapted | hibernatable `ws.send()` frames enter celld's existing per-cell output gate incrementally, tagged with the current committed position; the gate proves and flushes the durable FIFO prefix while the handler is suspended, and its final position covers a write with no later frame. The published SDK resume protocol is unchanged |
| OpenAI-compatible provider | `ai@6.0.259` and `@ai-sdk/openai@3.0.98` stream `llama-swap/Qwen3.6-35B-A3B` through a credential-free gateway URL | supported | the deterministic provider exercises the same chat-completions wire shape used by Strix without credentials |
| Bounded provider failures | public chat streams classify missing capability, unavailable provider, rejection, invalid output, and terminal interrupted output with stable codes | supported | upstream bodies, URLs, stack traces, and placeholder authorization values are not returned; `onChatResponse` uses public `persistMessages` to settle streaming parts and add bounded `metadata.celldStream` |
| Schema-validated server tools | deterministic memory and reminder calls persist completed tool parts and reject empty, oversized, malformed, or cross-Agent operations | adapted | published AI SDK tool execution runs unchanged; application-owned memory and reminder SQL remains bounded and isolated per cell |
| Agent schedules and celld alarms | repeated reminder calls deduplicate, cancellation is owner-scoped, completion wakes an inactive Agent, and `cf_agent_state` broadcasts completion to connected clients | adapted | the source-unmodified SDK owns schedule rows and alarm dispatch while celld persists and wakes the owning cell; Worker cron and client timers are not used |
| Agent state and application SQL persistence | `/current/state/<name>`, explicit memories, and reminder history remain isolated after inactivity and reconnect | adapted | `setState` and `this.sql` use the owning cell's authoritative SQLite database |
| Reviewed dependency set | `agents@0.21.0`, `@cloudflare/ai-chat@0.10.2`, `ai@6.0.259`, `@ai-sdk/openai@3.0.98`, `zod@4.4.3`, and `esbuild@0.28.2` are checked against lockfile integrity and digest | supported | the target is reproducible without Strix, Tailscale, or credentials |
| approval-gated tools, facets, and MCP | not exercised by this chat, resumption, and reminder slice | unsupported | follow-up tickets must add public-boundary evidence before support is claimed |

`adapted` means the published SDK code runs unchanged while celld supplies a
Durable Object/runtime boundary. It does not mean unsupported SDK features are
silently emulated.
