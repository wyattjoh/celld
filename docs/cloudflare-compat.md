# Cloudflare compatibility

celld runs the Workers runtime, with Durable Objects as the stateful
core: module Workers, fetch, JS RPC, service bindings, and static assets.
This page shows that Worker surface, API by API. celld does not run the
rest of the Cloudflare platform, and the scope rule is simple: if
Cloudflare builds a function on Durable Objects, celld can get that
function, and a function on a different primitive is out of scope.
Cloudflare builds D1 on Durable Objects, so a D1 binding is a thin layer
over what celld already has. KV is a global cache with eventual
consistency, and R2 is blob storage: different systems, not on the
roadmap.

A configuration or binding that is not available must fail loudly, at
deploy or at first use. A silent compatibility gap is a bug; the known
gaps have marks below.

## Services

| service | notes |
| --- | --- |
| **Workers** | Module Workers: `fetch`, JS RPC, service bindings, Durable Object bindings, `vars`. Cron triggers run the `scheduled` handler on celld's own alarms, one time for each occurrence in the whole fleet; see [Cron triggers](#cron-triggers). |
| **Durable Objects** | The stateful core. SQLite storage, alarms, inbound hibernatable WebSockets, outbound `ws:`/`wss:` WebSocket clients (constructor and `fetch()` upgrade), one writer for each cell, names as addresses, RPC methods on stubs. |
| **Computer filesystem-only Workspace** | **Adapted** for pinned `@cloudflare/computer@0.2.1`: a Workspace can use the owning cell's `ctx.storage` for durable `fs` operations. The pinned Worker Shell and Worker JavaScript backends are adapted through explicit loaded-worker capabilities when `CELLD_WORKER_LOADER` is configured; containers, R2 mounts, and Artifacts are not implied. |
| **Static assets** | Immutable files, served from the fleet bucket: `assets.directory`, `binding`, `html_handling`, `not_found_handling`, `run_worker_first`, plus `_headers` and `_redirects`. An asset-only project deploys without a Worker. |
| **Worker Loader (Code Mode)** | Experimental. Bind a loader with `CELLD_WORKER_LOADER`. A Worker can then start sandboxed isolates at runtime. See [Dynamic Worker loading](#dynamic-worker-loading-code-mode). |
| **D1** | Partial. `d1_databases` bindings give `prepare`, `bind`, `all`, `first`, `run`, `raw` and `exec`. The `celld d1` command runs SQL and migrations. See [D1](#d1). |

Planned: **Workflows** (durable execution over cells and alarms),
**Queues** (a Durable Object shape; if demand appears).

A note on durable execution, because the two terms are close. A
durable-execution engine (Temporal, Restate, Azure Durable Functions)
models a process: a sequence of steps that ends. A cell models an
entity: a named unit with state that persists indefinitely. You can
build either primitive on the other — Cloudflare builds Workflows on
Durable Objects — so choose the one that matches the shape of the
problem. A concert, a user, and a document are entities; an order
pipeline is a process.

Not planned: **KV** (a different consistency model), **R2** (celld runs
*on* blob storage; celld does not provide blob storage; declared
`r2_buckets` bindings load, but each method throws), **Cache API**,
**Workers AI, Vectorize, Hyperdrive, Browser Rendering, Email** (managed
platform services; the pinned Agents conformance fixture can use the
explicit HTTP AI adapter binding configured by `CELLD_AI_URL`), **custom
domains, TLS termination** (platform surface; put TLS in your ingress
proxy), **Python Workers** (workerd supplies the Pyodide runtime and the
Python module shim; that layer is platform surface, not a function on
Durable Objects; celld can add support if demand appears).

## Runtime APIs

Cloudflare's [Runtime APIs
index](https://developers.cloudflare.com/workers/runtime-apis/), category
by category:

| API | status |
| --- | --- |
| Fetch, Request, Response, Headers | **Yes.** Gaps: `Response.redirect()`, `Response.error()`, and the `cache` request option are missing. |
| Bindings (`env`) | **Yes** for Durable Objects, service bindings, `vars`, assets, D1, and the adapted HTTP AI binding. Other binding types are out of scope (see Services). A declared AI binding without `CELLD_AI_URL` fails clearly on first use. |
| Context (`ctx`) | **Yes**: `waitUntil`, `props`, `exports`. `passThroughOnException()` is accepted but has no effect. There is no CDN behind it. `ctx.facets` is absent (see Facets). |
| Handlers | `fetch`, `alarm`, `scheduled` (cron), `webSocketMessage`/`Close`/`Error`, RPC methods. **No** `queue`, `tail`, or `email` handlers. See [cron triggers](#cron-triggers). |
| RPC | **Yes**, for most of the surface. See [RPC](#rpc). |
| Streams | **Yes.** This includes byte streams, BYOB readers, `tee`/`pipeTo`/`pipeThrough`, `IdentityTransformStream`, `FixedLengthStream`, and `CompressionStream`/`DecompressionStream`. Gap: `ReadableStream.from()`. |
| Encoding | **Yes**: `TextEncoder`/`TextDecoder` (legacy encodings included), encoder and decoder streams, `atob`/`btoa`. |
| WebSockets | **Yes**, inbound (hibernatable, with attachments) and outbound. An attachment holds anything that structured clone accepts. A subrequest to a cell can upgrade, and the caller gets the client end as `response.webSocket`. The caller must call `accept()` on that socket, because an unaccepted socket delivers no message. Auto-response works: `setWebSocketAutoResponse` answers a matched message without a wake of the cell. Gap: `getTags()`. Divergence: `acceptWebSocket()` throws when the isolate is near its V8 heap limit (see [Isolate heap limit](#isolate-heap-limit)). |
| Web Crypto | **Partial**: `digest` (including MD5), HMAC sign and verify, AES-GCM, RSA-OAEP decrypt, Ed25519 and ECDSA-P256 sign, and `verify` for RSASSA-PKCS1-v1_5 and ECDSA-P256 (RS256 and ES256 JWTs). `importKey` and `exportKey` handle `spki`, `pkcs8`, `jwk` and `raw` for RSA, EC (P-256, P-384, P-521), Ed25519 and X25519, validating at import; keys cross to `node:crypto` through `KeyObject.from()`. `generateKey` covers AES, HMAC, RSA (OAEP, PKCS#1 v1.5, PSS), EC P-256 and Ed25519. Cloudflare's extensions `timingSafeEqual` and `DigestStream` (with CRC32, CRC32C and CRC64-NVME) are available. AES-CBC, AES-CTR and AES-GCM (12- or 16-byte IVs). ECDH `deriveBits` and `deriveKey` on P-256, P-384 and P-521. Missing: `wrapKey`/`unwrapKey`, RSA-PSS *signing*, HKDF and PBKDF2 through `deriveBits` (they are available through `node:crypto`). An algorithm that is not available throws. |
| Web standards | **Yes**: `URL`, `URLSearchParams`, `URLPattern`, `AbortController`/`AbortSignal` (with `timeout()`, `any()`; a signal does **not** abort across an RPC call, and `signal.onabort` is accepted but never invoked — use `addEventListener('abort')`), `Blob`/`File`/`FormData`, `Event`/`EventTarget`, `DOMException`, `queueMicrotask`, `structuredClone` (not conformant on exotic types), `navigator.userAgent`. |
| WebAssembly | **Yes** (V8's own, without restrictions). A bundle can import a `.wasm` file as a compiled module, as on Cloudflare; see [WebAssembly](wasm.md). |
| Performance and timers | `setTimeout`/`clearTimeout`, `setInterval`/`clearInterval`, `setImmediate`, `scheduler.wait()`. A Worker must clear each interval before the handler ends because an active interval keeps the request alive. `performance.now()` has millisecond resolution. The other parts of `performance` are stubs. |
| Console | `log`/`info`/`warn`/`error` are real. `debug`/`trace`/`group`/`table` do nothing. `assert`/`time`/`count` are absent. |
| Node.js compatibility | **Partial.** See [node: imports](#node-imports). |
| Facets (`ctx.facets`) | **No.** A Durable Object cannot create a facet, and `ctx.facets` is not defined. celld also has no first-class `DurableObjectClass` value, so `ctx.exports` gives no stub for a Durable Object class that the configuration does not declare. |
| Cache (`caches`) | **No.** |
| HTMLRewriter | **No.** |
| TCP sockets (`cloudflare:sockets`) | **No.** Known silent gap: `connect()` currently gives an inert stub. It does not throw. |
| EventSource, MessageChannel, BroadcastChannel | **No.** The classes exist so that bundles load, but they do nothing. |

## RPC

celld implements the Workers [JS RPC
system](https://developers.cloudflare.com/workers/runtime-apis/rpc/):
`WorkerEntrypoint` and `RpcTarget` from `cloudflare:workers`, named
entrypoints on service bindings, and method calls on Durable Object stubs
(this needs `extends DurableObject`, or the `js_rpc` compat flag).
Arguments and returns use structured clone. Functions, streams, and
`RpcTarget`s become stubs. Promise pipelining, `ctx.exports` loopback
stubs, and stubs in DO storage are available. `ctx.exports` covers the
entrypoints that the configuration declares, so it gives no stub for an
undeclared Durable Object class.

The current limits: a cross-isolate service binding with a named
entrypoint can do single method calls, but not `fetch()`, awaitable
properties, or pipelined paths; a same-isolate binding has the full
surface.

A stub cannot cross an isolate boundary yet, and a Durable Object is its
own isolate. A Durable Object method therefore takes and returns
structured-cloneable values. If you pass a function to one, or return an
`RpcTarget` from one, the call throws `RPC stubs cannot cross isolate
boundaries yet`. Callbacks, `RpcTarget` instances and promise pipelining
all work through `ctx.exports`, which shares the isolate. The
[`rpc` example](https://github.com/denoland/celld/tree/main/examples/rpc)
shows each of these.

## D1

A D1 database is a cell. The cell holds one SQLite database, and celld
replicates that database to the fleet bucket. Therefore a D1 database
gets the fencing, the replication, and the durable write acknowledgement
of a Durable Object.

Declare a database with the `d1_databases` key:

```jsonc
{
  "d1_databases": [
    { "binding": "DB", "database_name": "ledger" }
  ]
}
```

The `database_id` value is the stable database identity. The identity does
not change when a Worker name changes. Several Workers can use the same
identity, so they can reach the same database. celld uses `database_name`
when a declaration has no `database_id`.

These methods are available: `prepare()`, `bind()`, `all()`, `first()`,
`run()`, `raw()`, `exec()`, `batch()`, and `withSession()`. A batch runs
all of its statements in one transaction. A failed statement rolls back
the complete batch.

A session always uses the primary database because celld has no read
replica. The session accepts a Cloudflare constraint or an opaque bookmark.
It provides `prepare()`, `batch()`, and `getBookmark()`.

A statement result carries the standard `meta` fields. celld reports
`served_by_region` as `local`, and it reports `served_by_primary` as `true`.
The `rows_read` value uses the returned-row count and the SQLite full-scan
counter. It can differ when a query plan reads rows through an operation
that SQLite does not expose through that counter.

A failure has a `cause` property, and the message prefix identifies the
error family. A SQL failure gives `D1_ERROR:`. An unsupported bind value
gives `D1_TYPE_ERROR:`. An `exec()` failure gives `D1_EXEC_ERROR:`. A missing
column in `first(column)` gives `D1_COLUMN_NOTFOUND:`.

`bind()` accepts a number, a string, a boolean, a null, an `ArrayBuffer`, a
typed array, or an array of bytes. It converts a boolean to `1` or `0`, as
Cloudflare does. An `ArrayBuffer` stores its bytes as a BLOB. A typed array
stores its element values, and each element truncates to one byte. Cloudflare
uses the same conversion. A `NaN` or an `Infinity` value has no JSON form,
so `bind()` stores SQL `NULL`.

**One database has one writer.** A celld fleet gets more capacity from
more databases, and not from a larger database. Cloudflare gives the same
advice for the same reason.

A query through a binding must hold its full result in memory, because
the result crosses an isolate boundary. celld refuses a result of more
than 100,000 rows, and it refuses a result of more than 32 MiB. The
statement completes before the refusal, so the writes of an
`INSERT ... RETURNING` statement land even when the result is refused. A
Durable Object can read a larger result, because the cursor in a cell
streams the rows.

The `dump()` method and Time Travel are not available. The `wrangler d1`
commands and the D1 REST API do not operate against celld. Use `celld d1`
instead.

### The celld d1 command

`celld d1` runs SQL and migrations against a database that is deployed.
A database is a cell, so the command needs a running fleet. It finds a
node through the node leases in the bucket. That node then sends the work
to the node that owns the database. celld signs each request with the
fleet secret in the bucket, therefore the command needs the same bucket
credentials that `celld deploy` needs.

```sh
celld d1 migrations apply ledger --bucket s3://my-cells-bucket
celld d1 migrations list  ledger --bucket s3://my-cells-bucket
celld d1 execute ledger --command "SELECT count(*) FROM accounts;" \
  --bucket s3://my-cells-bucket
```

The command reads the project to resolve the selected `database_name` to its
stable identity. Give the project directory as an argument, or run the
command in that directory.

A migration is a `NNNN_description.sql` file in `migrations/`, and celld
applies the files in the order of their numeric prefixes, as wrangler
does. A file without a numeric prefix stops the command, because celld
cannot place the file in that order. Give the `d1_databases` entry a
`migrations_dir` value to move the directory, and a `migrations_table`
value to rename the bookkeeping table. celld records an applied migration
in that table, `d1_migrations` by default, and the table and the columns
match the table `wrangler d1 migrations` writes.

A project that moves from Cloudflare does not apply a migration twice when
the migration history arrives with the data. Export the database with
`wrangler d1 export`. Import the file with `celld d1 execute DATABASE --file
export.sql`. The import runs as one transaction with a 120-second budget. A
failed import rolls back the complete transaction. A large export can require
several smaller files.

The cell applies a migration and records it in one transaction, so a
migration that fails part-way rolls back whole. The database therefore
keeps neither a partial schema nor a record of work that did not land,
and you can correct the file and run the command again. A failure stops
the run, so the migrations after the failure do not run.

An `exec()` call runs in one transaction, so a call that fails part-way
rolls back whole. celld refuses SQL that ends in an incomplete statement
— an open quote, or a statement cut in the middle of a token — because
the engine does not run such a statement. A complete final statement does
not need a semicolon, and a comment after the last statement is
permitted.

## Dynamic Worker loading (Code Mode)

Set `CELLD_WORKER_LOADER=LOADER`. Workers then get `env.LOADER`. This is
an experimental port of Cloudflare's [Worker
Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/).
`loader.get(name, getCode)` (memoized) and `loader.load(code)` start a
new isolate for each loaded worker. These inputs are honored:
`mainModule`, sibling `modules`, `compatibilityDate`/`Flags`, plain-JSON
`env`, `globalOutbound: null` (no egress), and an explicit Fetcher broker.
The limits of workerd apply: 64 MiB of code and 1 MiB of env. celld
additionally bounds retained workers with `CELLD_MAX_LOADED_WORKERS` (default
256), concurrent loaded-worker fetch/RPC/capability calls with
`CELLD_MAX_LOADED_WORKER_CONCURRENCY` (default 64), and each loaded-worker
response with `CELLD_LOADED_WORKER_TIMEOUT_S` (defaulting to the normal handler
budget). `CELLD_MAX_LOADED_WORKER_MEMORY_MB` can set a node-wide Code Mode
reservation ceiling; otherwise the reservation is derived from the per-isolate
V8 heap limit and worker ceiling. Each bound has a distinct refusal error with
a stable `code` and `retryable` property, and pressure shedding rejects only
new Code Mode work. Idle loaded workers may be evicted under pressure, while
active calls finish their lifecycle and host mutations still use the owning
cell's normal output gate. A loaded worker serves `fetch()` and single RPC
method calls. Named loaded-worker RPC results and byte-shaped capability
results may carry bounded `Uint8Array` `ReadableStream`s; celld buffers them
at the isolate boundary for Worker Shell's framed events and Workspace file
reads. Capability values use an opaque sideband; host objects and credentials
never enter the loaded Worker's JSON environment. The sideband
supports the pinned Workspace, Library, Tools, and Fetcher proxy surfaces:

```js
const outbound = env.LOADER.fetcher(env.HTTP_GATEWAY, {
  // Origins and path prefixes are checked before gateway.fetch() runs.
  allow: ["https://api.example.com/v1"],
});
const tools = env.LOADER.tools([
  {
    name: "search",
    description: "Search approved documents",
    inputSchema: { type: "object" },
  },
], env.TOOL_BROKER);

const worker = env.LOADER.load({
  mainModule: "worker.js",
  modules: {
    "worker.js": workerSource,
    "helper.js": { js: helperSource },
    "add.wasm": { wasm: wasmBytes },
  },
  env: {
    WORKSPACE: env.LOADER.capability("workspace", workspace),
    TOOLS: tools,
    plainConfig: { mode: "safe" },
  },
  globalOutbound: outbound,
});
```

`WORKSPACE`, `LIBRARY`, and `TOOLS` are opaque proxies; host objects and
credentials never cross the isolate. `WORKSPACE.fs.readFile(path, "utf8")` and
`TOOLS.invoke(name, input)` are the supported Workspace and Tools calls;
`TOOLS.catalog` is a frozen copy of the host-approved metadata. A Library
grant is limited to one method hop on its supplied target. A Fetcher
capability exposes only `fetch()`, and its non-empty allowlist is checked by
origin and path before the host target is called. Responses cross back as
bounded structured-clone data/streams; broker response bodies are materialized
before crossing the host boundary, and every runtime stream handle is
owner-bound before it can be read, canceled, or tee'd. Capability arguments
remain clone-only; byte-shaped result streams are buffered within the same
bounded transport limit, so live backpressure and arbitrary stream values are
unsupported. The target stays rooted in the owning Agent isolate, so provider
credentials and fleet bindings remain host-side.

celld checks the host owner, Agent-loaded-worker identity, capability kind,
allowlist, and liveness before every call. Capability and worker handles use
process-random control values; numeric worker ids, copied proxy shapes, and
stale tokens are not authority. A host cell losing ownership revokes the
workers it minted before its storage closes, and node shutdown drains the
registry. `dispose()` on a worker or capability is idempotent, rejects new
calls, and releases host references after in-flight calls settle. Loaded-worker
cleanup is bounded by the normal handler budget; interruption errors identify
`cancelled`, `timed_out`, `isolate_failure`, `capability_failure`,
`host_cell_lost`, or `worker_disposed`. `{ js }` sibling modules and `{ wasm }`
sideband modules are supported. Ordinary JSON `env` values and normal Worker
`fetch()` behavior remain unchanged. `globalOutbound: null` always denies
ambient `fetch()`; omitting `globalOutbound` preserves the existing
parent/normal-Worker outbound policy. A non-null ordinary object is rejected
instead of being serialized or treated as unrestricted networking. Loaded
isolates replace raw host storage, DO, service, alarm, and loader-stub native
operations with bounded denials. When an Agent cell is evicted or its
activation ends, its loaded-worker registry entries are revoked immediately and
host references are released after in-flight calls settle. Awaitable properties
and pipelined capability calls remain unsupported. Unsupported values fail
with `DataCloneError` rather than crossing as host objects. Pressure does not
roll back an acknowledged Workspace mutation or evict its Agent cell: Code Mode
is disposable compute, while the cell remains the authoritative state and
mutation boundary.

## Computer filesystem-only Workspace

The pinned filesystem-only Computer surface is the smallest supported Computer
seam. An Agent may use the package's source-unmodified mixin with its own cell
storage:

```js
import { withWorkspace, getWorkspace } from "@cloudflare/computer";
import { Agent } from "@cloudflare/agents";

export class MyAgent extends withWorkspace(
  Agent,
  (self) => ({ storage: self.ctx.storage }),
) {
  async readNote() {
    const workspace = await getWorkspace(this);
    return workspace.fs.readFile("/notes.md", "utf8");
  }
}
```

The VFS tables are ordinary application tables in that Agent cell's
authoritative SQLite database. Activation, inactivity, eviction, restart, and
ownership restore therefore use the cell's existing storage and replication
path; there is no second Workspace database. A filesystem mutation advances the
cell write position, so the existing output gate withholds the response until
configured durability is proved. `CELLD_OUTPUT_GATE=0` explicitly disables that
wait and must not be described as RPO=0.

The pinned fixture exercises create, read, update, list, search, and delete,
plus local reopen and per-Agent isolation. With `CELLD_WORKER_LOADER=LOADER`,
it runs the pinned Worker Shell and Worker JavaScript backends in fresh loaded
workers. Worker Shell uses only core `just-bash` modules and the explicit
Workspace fs capability; Worker JavaScript uses a library capability, reads a
sibling module and Workspace file, returns structured data, and forwards
bounded framed stdio as bytes rather than exporting a live cross-isolate
stream. Neither backend grants native process, host filesystem, arbitrary TCP,
or ambient network access; unsupported commands, cancellation, and timeouts
return explicit bounded outcomes. The fixture's local tests are not evidence
of a live multi-node restore or ownership-transfer run.

## node: imports

`node:` specifiers are always available; the `nodejs_compat` flag is not
necessary, and celld does not read it. `celld deploy` externalizes `node:*`
and bare Node built-ins at bundle time. The runtime supplies its own subset
(it does not use the Wrangler-style unenv polyfills):

- **Implemented**: `node:assert`, `node:async_hooks` (a real
  `AsyncLocalStorage`), `node:buffer`, `node:events`, `node:path`,
  `node:stream` (+ `stream/web`, `stream/promises`, `stream/consumers`),
  `node:timers/promises`, `node:util`.
- **Partial**: `node:crypto` (hashes, HMAC, HKDF, PBKDF2, `webcrypto`, secret
  key objects, asymmetric keys, and one-shot signatures. `createPublicKey` and
  `createPrivateKey` read PEM, DER and JWK for RSA, EC (P-256, P-384, P-521),
  Ed25519, X25519 and DSA, including password-protected PKCS#8, and give a key
  with `asymmetricKeyType`, `asymmetricKeyDetails`, `toCryptoKey()` and
  `export()` to DER, PEM or JWK. `generateKeyPairSync` covers RSA, EC P-256,
  Ed25519 and X25519. `sign()` and `verify()` cover Ed25519, RSA PKCS#1 v1.5
  and ECDSA P-256, with DER signatures as Node's `dsaEncoding` default
  requires. What still throws: Diffie-Hellman throughout, the streaming
  `createSign`/`createVerify`, ciphers, RSA-PSS, DSA signing, and key
  generation for DSA and DH), `node:zlib` (only the sync `gzip`/`deflate`
  family), `node:fs` (reads fail with `ENOENT`, `existsSync` is `false`).
- **Not implemented**: the rest — `node:http(s)`, `node:net`,
  `node:tls`, `node:dns`, `node:os`, `node:process` (the `process`
  global exists, the module does not), `node:worker_threads`, `node:vm`,
  `node:child_process`, and the others. Known silent gap: these
  currently give inert stubs. They do not fail the import.

## Isolate heap limit

Each isolate has a V8 heap limit, and celld defaults it to 128 MB to
match a Durable Object on Cloudflare. `CELLD_V8_HEAP_LIMIT_MB` changes
it. celld keeps an isolate that reaches this limit, and Cloudflare
discards one. Two behaviors follow from that difference, and both
diverge from workerd on purpose.

`state.acceptWebSocket()` throws when the isolate uses more than 90% of
the limit. A hibernatable WebSocket is state that the cell holds until
the peer goes away, so a cell that accepts more sockets than it can
carry serves none of them. The error names the heap and
`CELLD_V8_HEAP_LIMIT_MB`. Cloudflare does not refuse the accept.

`SqlStorage.Cursor.toArray()` throws a different message. workerd throws
`result set is too large to fit in memory`. The guard tests the heap of
the isolate and not the size of the result, so it fires for a query that
returns one row, and the workerd message then names the wrong cause.
celld names the heap instead.

Neither state is permanent. celld measures the heap before each event
and lifts the refusal when the heap drains. A restart of the process is
not necessary. The [README](../README.md#operate-a-fleet) gives the
thresholds.

## Cron triggers

celld runs the `scheduled` handler on a cron schedule. Put the
expressions in `triggers.crons` in the Wrangler configuration, and export
`scheduled(controller, env, ctx)` from the default entrypoint. The
`controller` gives `scheduledTime`, `cron`, and `noRetry()`, as on
Cloudflare.

An expression has the five standard fields: minute, hour, day of month,
month, and day of week. A field accepts `*`, a value, an `a-b` range, an
`a,b` list, and a `/n` step. The month and day-of-week fields also accept
the three-letter names. The day-of-month field accepts `L`, `L-<n>`, `LW`,
`L-<n>W`, and `<day>W`. The day-of-week field accepts `<day>L` and
`<day>#<n>`. If the day-of-month field and the day-of-week field are both
not `*`, a day matches when one of them matches.

The day-of-week numbers are Cloudflare's: 1 is Sunday and 7 is Saturday.
Other cron systems number the same days 0 to 6 from Sunday, so `1-5` is
Sunday to Thursday here and not Monday to Friday. celld refuses 0. Use
the names to avoid the question.

A step must be smaller than the width of its field, so `*/60` in the
minute field is an error and not a spelling of "every hour". Cloudflare
applies the same bound.

celld refuses two expressions that Cloudflare accepts, and both refusals
stop the deploy with an error:

- A descending range, such as `SAT-SUN` or `NOV-FEB`. Cloudflare wraps a
  descending range around the end of the field and includes one value too
  many: `SAT-SUN` matches Friday there. celld does not copy that result
  and does not silently correct it.
- A `*` inside a list, such as `1,*`. Cloudflare reads this `*` as the
  lowest value of the field, so `1,*` is minute 0 and minute 1.

celld also refuses `?`, as Cloudflare does.

A cron runs on one node in the fleet, and celld gives these guarantees:

- The resolution is one minute, and the zone is UTC.
- The handler runs one time for each occurrence that the fleet is up for,
  in the whole fleet.
- Only one handler runs at a time for a script. A slow handler therefore
  delays the next occurrence.
- The handler can run late, but it never runs early. If the fleet is
  down, celld runs the missed occurrence one time and does not run the
  other missed occurrences. `controller.scheduledTime` is always the
  occurrence, and not the moment the handler started.
- celld retries a handler that throws, with an increasing delay, and it
  retries only the expression that threw. A retry that is still owed when
  the next occurrence comes is cancelled, so a retry can never delay or
  cancel a scheduled run. `controller.noRetry()` also cancels the retry.

celld builds this on its alarms, so a cron schedule is durable. celld also
uses the schedule from the deployment it runs under. A new deployment with
different expressions therefore takes effect without a migration. A node
runs the schedule of its own deployment only. If a script that a service
binding points to declares `triggers.crons`, celld writes a warning and
does not run them.

## Compatibility flags

`compatibility_date` and `compatibility_flags` are honored for the
switches that celld models: `delete_all_deletes_alarm`, `js_rpc`,
`fetcher_no_get_put_delete`, `sqlite_vec`, `websocket_standard_binary_type`,
and the assets navigation behavior. The `sqlite_vec` flag enables the pre-v1
sqlite-vec extension, and a compatibility date never enables it.
`Cloudflare.compatibilityFlags` reports only
the flags that celld honors. A flag that celld does not model is absent
rather than reported as enabled, and celld accepts it without effect.

## Wrangler configuration

`celld deploy` builds a standard Wrangler project (esbuild on `PATH`)
and accepts `wrangler.jsonc` or `wrangler.json`, not `wrangler.toml`.
The available config keys are `name`, `main`,
`compatibility_date`, `compatibility_flags`, `durable_objects`,
`migrations`, `assets`, `ai`, `services`, `triggers`, `vars`, and
`d1_databases`. The `ai.binding` key creates the adapted HTTP AI binding;
set `CELLD_AI_URL` on the node or the binding fails clearly on first use.
An asset-only project can omit `main`. celld refuses symlinks and special
files in the asset directory, and `.assetsignore` still needs Wrangler.
Each other key — `routes`, `kv_namespaces`, and the rest — stops the deploy
with an error that names the key: remove the key, or deploy that project
with Wrangler.

This page is the reference for the implemented Worker surface. For the
operational boundaries of the current release — TLS, platforms, pressure
shedding, updates — see the [limitations](limitations.md).
