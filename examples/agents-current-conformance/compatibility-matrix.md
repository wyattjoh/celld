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
| OpenAI-compatible provider | `ai@6.0.259` and `@ai-sdk/openai@3.0.98` stream `llama-swap/Qwen3.6-35B-A3B` through a credential-free gateway URL | supported | the deterministic provider exercises the same chat-completions wire shape used by Strix without credentials |
| Bounded provider failures | public chat streams classify missing capability, unavailable provider, rejection, and invalid output with stable codes | supported | upstream bodies, URLs, stack traces, and placeholder authorization values are not returned |
| Schema-validated server tools | deterministic `rememberFact`, `listMemories`, and `summarizeMemories` calls persist completed tool parts and reject empty, oversized, or cross-Agent-shaped writes | adapted | published AI SDK tool execution runs unchanged; application-owned explicit-memory SQL remains bounded and isolated per cell |
| Agent state and application SQL persistence | `/current/state/<name>` and explicit memories remain isolated after inactivity and reconnect | adapted | `setState` and `this.sql` use the owning cell's authoritative SQLite database |
| Reviewed dependency set | `agents@0.21.0`, `@cloudflare/ai-chat@0.10.2`, `ai@6.0.259`, `@ai-sdk/openai@3.0.98`, `zod@4.4.3`, and `esbuild@0.28.2` are checked against lockfile integrity and digest | supported | the target is reproducible without Strix, Tailscale, or credentials |
| interrupted-stream resumption, approval-gated tools, facets, and MCP | not exercised by this chat slice | unsupported | follow-up tickets must add public-boundary evidence before support is claimed |

`adapted` means the published SDK code runs unchanged while celld supplies a
Durable Object/runtime boundary. It does not mean unsupported SDK features are
silently emulated.
