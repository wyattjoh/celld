import {
  getAgentByName,
  routeAgentRequest,
} from "agents";
import {
  getWorkspace,
  withWorkspace,
  WorkspaceServiceProxy,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { WorkerJavaScriptBackend } from "@cloudflare/computer/backends/worker-javascript";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { autoTransformMessages } from "@cloudflare/ai-chat/ai-chat-v5-migration";

// The Worker Shell backend asks the host cell for this entrypoint over the
// granted Workspace capability. Re-exporting the pinned package class makes
// it available through the same-isolate ctx.exports surface without patching
// the package implementation.
export { WorkspaceServiceProxy };

const AGENT_NAMES = new Set(["alpha", "beta"]);
const SESSION_STATE_ID = "default";

function initialSessionState(name) {
  return {
    agent: name,
    messageCount: 0,
    connectionCount: 0,
    scheduledRuns: 0,
    lastMessage: null,
    lastScheduled: null,
    lastConnectionId: null,
  };
}

const WORKSPACE_OPERATIONS = new Set([
  "create",
  "read",
  "update",
  "list",
  "search",
  "delete",
]);

const MODEL = "celld-deterministic-test";
const CHAT_CONTENT_TYPE = "text/plain; charset=utf-8";
const DEFAULT_JAVASCRIPT_SOURCE = `
import { suffix } from "./helper.js";
import { readFile } from "node:fs/promises";

export default async function (input) {
  const content = await readFile("/workspace/javascript-input.txt", "utf8");
  return { input, suffix, content };
}
`;
const WASM_ADD = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);
const LOADER_MODULE_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { label } from "./nested/loader-helper.js";
import wasm from "./add.wasm";

export default class extends WorkerEntrypoint {
  async run(input) {
    const instance = new WebAssembly.Instance(wasm);
    return { input, label, sum: instance.exports.add(20, 22) };
  }
}
`;

// The black-box Code Mode routes below exercise the same public Worker Loader
// surface as the deployed application. Keeping the module in the fixture
// makes the e2e runner independent of celld's implementation details while
// still covering host capability calls, eviction, admission, egress, output,
// and nested module resolution.
const CODE_MODE_SOURCE = `
import { WorkerEntrypoint } from "cloudflare:workers";

export default class extends WorkerEntrypoint {
  async run(input) {
    if (input.operation === "library") {
      return { mutation: await this.env.LIBRARY.mutate(input.value) };
    }
    if (input.operation === "disposed") {
      return await this.env.LIBRARY.ping(input.value);
    }
    if (input.operation === "wait") {
      return await this.env.LIBRARY.wait();
    }
    if (input.operation === "egress") {
      const response = await this.env.OUTBOUND.fetch(input.url);
      return { status: response.status, body: await response.text() };
    }
    if (input.operation === "tools") {
      return {
        catalog: this.env.TOOLS.catalog,
        result: await this.env.TOOLS.invoke("echo", input.value),
      };
    }
    if (input.operation === "output") {
      const bytes = new Uint8Array(input.size);
      bytes.fill(65);
      const result = await this.env.LIBRARY.attachOutput(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
      return { result };
    }
    if (input.operation === "timeout") {
      await new Promise((resolve) => setTimeout(resolve, input.delayMs));
      return { completed: true };
    }
    throw new TypeError("unknown Code Mode conformance operation");
  }
}
`;

const CODE_MODE_MODULES = {
  "code-mode/main.js": CODE_MODE_SOURCE,
};

/**
 * Adapt the pinned Computer loader contract to celld's explicit capability
 * sideband. The backend receives no host object: only this small library
 * target is granted to the loaded worker. Output is intentionally drained by
 * celld's no-stdio loader path for this first integration.
 */
function computerLoader(loader) {
  return {
    load(code) {
      const worker = loader.load(code);
      return {
        getEntrypoint(name, options) {
          const entrypoint = worker.getEntrypoint(name, options);
          return {
            evaluate(input, host, context) {
              const library = Object.freeze({
                call: (...args) => host.call(...args),
                assertResult: (...args) => host.assertResult(...args),
                attachOutputBytes: async (bytes) => {
                  if (!(bytes instanceof Uint8Array)) {
                    throw new TypeError(
                      "Worker JavaScript output must be a Uint8Array",
                    );
                  }
                  const output = new ReadableStream({
                    start(controller) {
                      controller.enqueue(bytes);
                      controller.close();
                    },
                  });
                  return host.attachOutput(output);
                },
                attachOutput: async () => {},
              });
              return entrypoint.evaluate(
                input,
                loader.capability("library", library),
                context,
              );
            },
          };
        },
        dispose() {
          worker.dispose();
        },
        [Symbol.dispose]() {
          worker.dispose();
        },
      };
    },
  };
}

class InvalidChatRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidChatRequestError";
  }
}

function chunkBytes(value) {
  return Uint8Array.from(JSON.parse(value));
}

function encodeChunk(chunk) {
  return JSON.stringify(Array.from(chunk));
}

function byteStream(chunks) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index === chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
  });
}

function agentNameFromPath(pathname) {
  const name = pathname.slice("/conformance/call/".length);
  return AGENT_NAMES.has(name) ? name : null;
}

function json(value, init) {
  return Response.json(value, init);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function chatMessages(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidChatRequestError("chat requires a non-empty messages array");
  }
  return value.map((message, index) => {
    if (!message || typeof message !== "object") {
      throw new InvalidChatRequestError(`chat message ${index} must be an object`);
    }
    if (typeof message.id !== "string" || message.id.length === 0) {
      throw new InvalidChatRequestError(`chat message ${index} requires a stable id`);
    }
    if (!["system", "user", "assistant"].includes(message.role)) {
      throw new InvalidChatRequestError(`chat message ${index} has an unsupported role`);
    }
    if (typeof message.content !== "string") {
      throw new InvalidChatRequestError(`chat message ${index} requires string content`);
    }
    return {
      id: message.id,
      role: message.role,
      content: message.content,
    };
  });
}

function requestMessages(payload) {
  return chatMessages(payload?.messages);
}

async function requestMessagesFrom(request) {
  try {
    return requestMessages(await request.json());
  } catch (error) {
    if (error instanceof InvalidChatRequestError) throw error;
    throw new InvalidChatRequestError("chat request body must be valid JSON");
  }
}

function safeErrorMessage(error) {
  return errorMessage(error).replace(/https?:\/\/[^\s"']+/g, "<redacted-url>");
}

function wireError(error) {
  const message = safeErrorMessage(error);
  const metadata = message.match(/\[(code_mode\.[^;\]]+); retryable=(true|false)\]/);
  return {
    code: typeof error?.code === "string" ? error.code : metadata?.[1] ?? null,
    retryable: typeof error?.retryable === "boolean"
      ? error.retryable
      : metadata ? metadata[2] === "true" : null,
    message,
  };
}

// Keep one stale stub outside the Agent instance so an operator eviction can
// be followed by a request that uses the exact handle minted before eviction.
// The runtime must reject it rather than routing it into the reactivated cell.
const STALE_CODE_MODE_HANDLES = new Map();

function shellBackends(self) {
  const loader = self.env?.LOADER;
  if (loader === undefined) return [];
  return [new WorkerShellBackend({
    id: "worker-shell",
    loader,
    workspace: {
      binding: "agents",
      id: self.ctx.id.toString(),
    },
    ctx: self.ctx,
    // The shell has the Workspace capability only. Do not opt into the
    // package's direct or HTTP-gateway egress modes for this fixture.
    egress: { mode: "none" },
  })];
}

/**
 * Source-unmodified AIChatAgent used by the celld compatibility fixture.
 * The callable method returns nested cloneable data, while the HTTP chat seam
 * invokes the inherited chat hook without patching the upstream source.
 *
 * The normal Agents SDK chat protocol is WebSocket based; this fixture keeps
 * that inherited surface untouched, while its HTTP conformance route invokes
 * the same onChatMessage hook directly. The filesystem-only Computer seam
 * receives this Agent cell's storage object, so its VFS tables share the
 * authoritative SQLite database with Agent state and SQL.
 */
export class ConformanceAgent extends withWorkspace(
  AIChatAgent,
  (self) => {
    const loader = self.env?.LOADER;
    const javascriptBackends = loader === undefined
      ? []
      : [new WorkerJavaScriptBackend({
          id: "worker-javascript",
          loader: computerLoader(loader),
          globalOutbound: null,
          compatibilityDate: "2026-01-01",
          compatibilityFlags: ["nodejs_compat", "experimental"],
        })];
    return {
      storage: self.ctx.storage,
      backends: [...javascriptBackends, ...shellBackends(self)],
    };
  },
) {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql`
      CREATE TABLE IF NOT EXISTS conformance_agent_records (
        id TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        revision INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS conformance_agent_session_state (
        id TEXT PRIMARY KEY NOT NULL,
        message_count INTEGER NOT NULL,
        connection_count INTEGER NOT NULL,
        scheduled_runs INTEGER NOT NULL,
        last_message TEXT,
        last_scheduled TEXT,
        last_connection_id TEXT
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS conformance_agent_session_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL,
        message TEXT NOT NULL,
        message_count INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS conformance_agent_schedule_runs (
        id TEXT PRIMARY KEY NOT NULL,
        payload TEXT NOT NULL,
        scheduled_time INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS conformance_code_mode_mutations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        value TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS conformance_ai_responses (
        response_id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        messages TEXT NOT NULL,
        lease TEXT,
        lease_until INTEGER NOT NULL DEFAULT 0
      )
    `;
    const responseColumns = this.sql`
      PRAGMA table_info(conformance_ai_responses)
    `;
    if (!responseColumns.some((column) => column.name === "lease")) {
      this.sql`ALTER TABLE conformance_ai_responses ADD COLUMN lease TEXT`;
    }
    if (!responseColumns.some((column) => column.name === "lease_until")) {
      this.sql`ALTER TABLE conformance_ai_responses ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0`;
    }
    this.sql`
      CREATE TABLE IF NOT EXISTS conformance_ai_response_chunks (
        response_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        chunk TEXT NOT NULL,
        PRIMARY KEY (response_id, sequence)
      )
    `;
  }

  sessionSnapshot() {
    const rows = this.sql`
      SELECT message_count, connection_count, scheduled_runs,
             last_message, last_scheduled, last_connection_id
      FROM conformance_agent_session_state
      WHERE id = ${SESSION_STATE_ID}
    `;
    const row = rows[0];
    if (row) {
      let lastScheduled = null;
      try {
        lastScheduled = row.last_scheduled === null
          ? null
          : JSON.parse(row.last_scheduled);
      } catch {
        // Treat a malformed fixture row as an empty optional value.
      }
      return {
        agent: this.name,
        messageCount: row.message_count,
        connectionCount: row.connection_count,
        scheduledRuns: row.scheduled_runs,
        lastMessage: row.last_message,
        lastScheduled,
        lastConnectionId: row.last_connection_id,
      };
    }

    // Older deployed revisions kept these fields in Agent.state. Read them
    // once as a compatibility bridge, but never write session fields back
    // into the public stateAndSql value.
    const legacy = this.state;
    if (!legacy || typeof legacy !== "object" ||
        !Number.isSafeInteger(legacy.messageCount)) {
      return initialSessionState(this.name);
    }
    return {
      ...initialSessionState(this.name),
      messageCount: legacy.messageCount,
      connectionCount: Number.isSafeInteger(legacy.connectionCount)
        ? legacy.connectionCount
        : 0,
      scheduledRuns: Number.isSafeInteger(legacy.scheduledRuns)
        ? legacy.scheduledRuns
        : 0,
      lastMessage: legacy.lastMessage ?? null,
      lastScheduled: legacy.lastScheduled ?? null,
      lastConnectionId: legacy.lastConnectionId ?? null,
    };
  }

  persistSessionState(state) {
    this.sql`
      INSERT OR REPLACE INTO conformance_agent_session_state
        (id, message_count, connection_count, scheduled_runs,
         last_message, last_scheduled, last_connection_id)
      VALUES (
        ${SESSION_STATE_ID}, ${state.messageCount}, ${state.connectionCount},
        ${state.scheduledRuns}, ${state.lastMessage},
        ${state.lastScheduled === null ? null : JSON.stringify(state.lastScheduled)},
        ${state.lastConnectionId}
      )
    `;
  }

  onConnect(connection) {
    const state = this.sessionSnapshot();
    const next = {
      ...state,
      connectionCount: state.connectionCount + 1,
      lastConnectionId: connection.id,
    };
    this.persistSessionState(next);
    connection.setState({
      messageCount: next.messageCount,
      connectionCount: next.connectionCount,
    });
    connection.send(JSON.stringify({
      type: "connected",
      connectionId: connection.id,
      state: next,
    }));
  }

  onMessage(connection, message) {
    const text = typeof message === "string" ? message : "[binary]";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const value = typeof parsed === "string"
      ? parsed
      : typeof parsed?.message === "string"
        ? parsed.message
        : text;
    const state = this.sessionSnapshot();
    const next = {
      ...state,
      messageCount: state.messageCount + 1,
      lastMessage: value,
      lastConnectionId: connection.id,
    };
    this.persistSessionState(next);
    this.sql`
      INSERT INTO conformance_agent_session_events
        (connection_id, message, message_count)
      VALUES (${connection.id}, ${value}, ${next.messageCount})
    `;
    connection.setState({
      ...(connection.state ?? {}),
      messageCount: next.messageCount,
    });
    connection.send(JSON.stringify({
      type: "message",
      connectionId: connection.id,
      state: next,
    }));
  }

  async scheduleWork(input) {
    const name = input?.name;
    const delaySeconds = input?.delaySeconds;
    if (typeof name !== "string" || !AGENT_NAMES.has(name)) {
      throw new TypeError("scheduleWork requires one of the pinned agent names");
    }
    if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 1) {
      throw new TypeError("scheduleWork requires a positive integer delaySeconds");
    }
    await this.setName(name);
    const schedule = await this.schedule(
      delaySeconds,
      "recordScheduledWork",
      input?.payload ?? null,
    );
    return {
      agent: this.name,
      schedule,
      alarm: await this.ctx.storage.getAlarm(),
      state: this.sessionSnapshot(),
    };
  }

  recordScheduledWork(payload, schedule) {
    const state = this.sessionSnapshot();
    const next = {
      ...state,
      scheduledRuns: state.scheduledRuns + 1,
      lastScheduled: { id: schedule.id, payload },
    };
    this.persistSessionState(next);
    this.sql`
      INSERT OR REPLACE INTO conformance_agent_schedule_runs
        (id, payload, scheduled_time)
      VALUES (${schedule.id}, ${JSON.stringify(payload)}, ${schedule.time})
    `;
  }

  async sessionStatus(input) {
    const name = input?.name;
    if (typeof name !== "string" || !AGENT_NAMES.has(name)) {
      throw new TypeError("sessionStatus requires one of the pinned agent names");
    }
    await this.setName(name);
    return {
      agent: this.name,
      state: this.sessionSnapshot(),
      events: this.sql`
        SELECT sequence, connection_id, message, message_count
        FROM conformance_agent_session_events
        ORDER BY sequence
      `,
    };
  }

  async scheduleStatus(input) {
    const name = input?.name;
    if (typeof name !== "string" || !AGENT_NAMES.has(name)) {
      throw new TypeError("scheduleStatus requires one of the pinned agent names");
    }
    await this.setName(name);
    return {
      agent: this.name,
      state: this.sessionSnapshot(),
      alarm: await this.ctx.storage.getAlarm(),
      pending: this.getSchedules(),
      runs: this.sql`
        SELECT id, payload, scheduled_time
        FROM conformance_agent_schedule_runs
        ORDER BY scheduled_time, id
      `,
    };
  }

  async conformance(input) {
    const name = input?.name;
    if (typeof name !== "string" || !AGENT_NAMES.has(name)) {
      throw new TypeError("conformance requires one of the pinned agent names");
    }

    // getAgentByName() sets this name asynchronously. Calling setName here as
    // well makes the method deterministic when the RPC call wins that race.
    await this.setName(name);
    return {
      agent: this.name,
      input: {
        name,
        sequence: [1, 2, 3],
        nested: { cloneable: true },
      },
    };
  }

  /**
   * Exercise the Agent state and SQL surfaces without sharing a database.
   * The runtime gives every named Agent its own authoritative cell, so the
   * ordered SQL result can only contain this Agent's record.
   */
  async stateAndSql(input) {
    const name = input?.name;
    if (typeof name !== "string" || !AGENT_NAMES.has(name)) {
      throw new TypeError("stateAndSql requires one of the pinned agent names");
    }
    await this.setName(name);

    if (input?.operation === "write") {
      const value = input.value;
      const revision = input.revision;
      if (typeof value !== "string" || !Number.isSafeInteger(revision)) {
        throw new TypeError("stateAndSql writes require a string value and integer revision");
      }
      this.setState({ agent: name, value, revision });
      this.sql`
        INSERT OR REPLACE INTO conformance_agent_records (id, value, revision)
        VALUES (${name}, ${value}, ${revision})
      `;
    } else if (input?.operation !== undefined && input.operation !== "read") {
      throw new TypeError("stateAndSql operation must be read or write");
    }

    return {
      agent: this.name,
      state: this.state ?? null,
      sql: this.sql`
        SELECT id, value, revision
        FROM conformance_agent_records
        ORDER BY id
      `,
    };
  }

  /**
   * Exercise the pinned filesystem-only Computer surface from the owning
   * Agent cell. The shell backend is a separate loaded-worker surface below;
   * both use this Agent cell's authoritative Workspace tables.
   * Mutating calls return only after the host's normal cell output gate sees
   * the SQLite write position advance.
   */
  async workspace(input) {
    const name = input?.name;
    if (typeof name !== "string" || !AGENT_NAMES.has(name)) {
      throw new TypeError("workspace requires one of the pinned agent names");
    }
    const operation = input?.operation;
    if (typeof operation !== "string" || !WORKSPACE_OPERATIONS.has(operation)) {
      throw new TypeError(
        "workspace operation must be create, read, update, list, search, or delete",
      );
    }
    await this.setName(name);

    const workspace = await getWorkspace(this);
    const path = input?.path;
    const requirePath = () => {
      if (typeof path !== "string" || !path.startsWith("/")) {
        throw new TypeError("workspace paths must be absolute strings");
      }
      return path;
    };

    if (operation === "create" || operation === "update") {
      const content = input?.content;
      if (typeof content !== "string") {
        throw new TypeError("workspace writes require string content");
      }
      const target = requirePath();
      await workspace.fs.writeFile(target, content, {
        exclusive: operation === "create",
      });
      return {
        agent: this.name,
        operation,
        path: target,
        stat: await workspace.fs.stat(target),
      };
    }

    if (operation === "read") {
      const target = requirePath();
      return {
        agent: this.name,
        operation,
        path: target,
        content: await workspace.fs.readFile(target, "utf8"),
      };
    }

    if (operation === "list") {
      const prefix = path === undefined ? "/" : requirePath();
      return {
        agent: this.name,
        operation,
        path: prefix,
        files: await workspace.fs.ls(prefix),
      };
    }

    if (operation === "search") {
      const query = input?.query;
      if (typeof query !== "string") {
        throw new TypeError("workspace search requires a string query");
      }
      const prefix = path === undefined ? "/" : requirePath();
      return {
        agent: this.name,
        operation,
        path: prefix,
        query,
        hits: await workspace.fs.grep(query, prefix, {
          ignoreCase: input?.ignoreCase === true,
        }),
      };
    }

    const target = requirePath();
    await workspace.fs.rm(target, {
      recursive: input?.recursive === true,
      force: input?.force === true,
    });
    return { agent: this.name, operation, path: target, deleted: true };
  }

  /**
   * Run one pinned just-bash Worker Shell command through a fresh loaded
   * worker. The package's backend uses only the explicitly granted Workspace
   * capability and `globalOutbound: null`; it never receives a host path,
   * process handle, socket, or ambient network authority.
   */
  async shell(input) {
    const name = input?.name;
    if (typeof name !== "string" || !AGENT_NAMES.has(name)) {
      throw new TypeError("shell requires one of the pinned agent names");
    }
    const command = input?.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new TypeError("shell requires a non-empty command string");
    }
    if (this.env?.LOADER === undefined) {
      throw new Error(
        "Worker Shell requires the LOADER Worker Loader deployment capability",
      );
    }
    const timeoutMs = input?.timeoutMs;
    if (timeoutMs !== undefined &&
        (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)) {
      throw new TypeError("shell timeoutMs must be an integer between 1 and 30000");
    }
    await this.setName(name);
    const workspace = await getWorkspace(this);
    const run = await workspace.runtime.exec(command, {
      backend: "worker-shell",
      encoding: "utf8",
      cwd: input?.cwd,
      env: input?.env,
      stdin: input?.stdin,
      timeoutMs,
    });
    const result = await run.result();
    const stderr = result.stderr;
    const outcome = result.status === "cancelled" || result.exitCode === 130
      ? "interrupted"
      : result.exitCode === 124 ? "timed_out"
      : result.exitCode === 127 && /command not found|not found/i.test(stderr)
        ? "unsupported_command"
        : result.status === "completed" && result.exitCode === 0
          ? "completed" : "failed";
    return {
      agent: this.name,
      backend: run.backend,
      id: run.id,
      command,
      outcome,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr,
    };
  }

  /**
   * Drive the public Worker Loader seam directly. These operations are small,
   * deterministic probes for lifecycle, capability, admission, egress, and
   * bounded transport behavior; none reaches into celld's private runtime
   * state.
   */
  async codeMode(input) {
    const name = input?.name;
    if (typeof name !== "string" || !AGENT_NAMES.has(name)) {
      throw new TypeError("codeMode requires one of the pinned agent names");
    }
    await this.setName(name);
    const loader = this.env?.LOADER;
    if (!loader) {
      throw new Error(
        "Worker Loader is unavailable; set CELLD_WORKER_LOADER=LOADER",
      );
    }
    const operation = input?.operation ?? "disposed";

    const agent = this;
    const libraryTarget = {
      async mutate(value) {
        const delayMs = input?.delayMs ?? 0;
        if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
          throw new TypeError("code-mode mutation delayMs must be bounded");
        }
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        agent.sql`
          INSERT INTO conformance_code_mode_mutations (agent, value)
          VALUES (${agent.name}, ${String(value)})
        `;
        return { agent: agent.name, value: String(value) };
      },
      ping(value) {
        return { agent: agent.name, value };
      },
      wait() {
        return new Promise(() => {});
      },
      attachOutputBytes(bytes) {
        if (!(bytes instanceof Uint8Array)) {
          throw new TypeError("code-mode output must be bytes");
        }
        return {
          length: bytes.byteLength,
          first: bytes[0] ?? null,
          last: bytes.at(-1) ?? null,
        };
      },
      attachOutput(bytes) {
        return this.attachOutputBytes(bytes);
      },
    };
    const outboundTarget = {
      async fetch(request) {
        return new Response(`approved:${request.url}`, {
          headers: { "content-type": "text/plain" },
        });
      },
    };
    const toolsTarget = {
      invoke(tool, value) {
        return { tool, value, agent: agent.name };
      },
    };
    const config = (env = {
      LIBRARY: loader.capability("library", libraryTarget),
      OUTBOUND: loader.fetcher(outboundTarget, {
        allow: ["https://approved.example/api"],
      }),
      TOOLS: loader.tools([
        {
          name: "echo",
          description: "Return the supplied value",
          inputSchema: { type: "object" },
          ["se" + "cret"]: "must-not-cross-the-sideband",
        },
      ], toolsTarget),
    }) => ({
      mainModule: "code-mode/main.js",
      modules: CODE_MODE_MODULES,
      env,
      compatibilityDate: "2026-01-01",
      compatibilityFlags: ["js_rpc"],
      globalOutbound: null,
    });

    if (operation === "admission") {
      const probes = [
        {
          label: "code_size",
          config: {
            ...config({}),
            modules: {
              "code-mode/main.js": `${CODE_MODE_SOURCE}${"x".repeat(64 * 1024 * 1024 + 1)}`,
            },
          },
        },
        {
          label: "env_size",
          config: {
            ...config({}),
            env: { oversized: "x".repeat(1024 * 1024 + 1) },
          },
        },
      ];
      const results = [];
      for (const probe of probes) {
        let worker;
        try {
          worker = loader.load(probe.config);
          await worker.getEntrypoint().run({ operation: "disposed" });
          results.push({ label: probe.label, accepted: true });
        } catch (error) {
          results.push({ label: probe.label, error: wireError(error) });
        } finally {
          worker?.dispose();
        }
      }
      return { agent: this.name, results };
    }

    if (operation === "eviction-prepare") {
      const worker = loader.get(
        "conformance-eviction-probe",
        () => config(),
      );
      STALE_CODE_MODE_HANDLES.set(this.name, worker);
      const ready = await worker.getEntrypoint().run({
        operation: "disposed",
        value: "before-eviction",
      });
      return {
        agent: this.name,
        scope: this.ctx.id.toString(),
        ready,
      };
    }

    if (operation === "eviction-stale") {
      const worker = STALE_CODE_MODE_HANDLES.get(this.name);
      if (!worker) {
        return {
          agent: this.name,
          error: {
            code: "code_mode.host_lost",
            retryable: true,
            message: "worker loader: stale handle was not retained",
          },
        };
      }
      try {
        const value = await worker.getEntrypoint().run({
          operation: "disposed",
          value: "after-eviction",
        });
        return { agent: this.name, value };
      } catch (error) {
        return { agent: this.name, error: wireError(error) };
      }
    }

    const worker = loader.load(config());
    const entrypoint = worker.getEntrypoint();
    try {
      if (operation === "disposed") {
        const before = await entrypoint.run({
          operation: "disposed",
          value: input?.value ?? "before-dispose",
        });
        worker.dispose();
        await new Promise((resolve) => setTimeout(resolve, 10));
        try {
          await entrypoint.run({ operation: "disposed", value: "after-dispose" });
          return { agent: this.name, before, disposed: false };
        } catch (error) {
          return {
            agent: this.name,
            before,
            disposed: true,
            error: wireError(error),
          };
        }
      }
      if (operation === "mutation") {
        const value = await entrypoint.run({
          operation: "library",
          value: input?.value ?? "acknowledged",
        });
        return {
          agent: this.name,
          value,
          mutations: this.sql`
            SELECT agent, value
            FROM conformance_code_mode_mutations
            WHERE agent = ${this.name}
            ORDER BY id DESC
            LIMIT 1
          `,
        };
      }
      if (operation === "output") {
        const size = input?.size ?? 8 * 1024 * 1024 + 1024;
        return {
          agent: this.name,
          requested: size,
          value: await entrypoint.run({ operation, size }),
        };
      }
      const value = await entrypoint.run({
        ...input,
        operation,
        url: input?.url ?? "https://approved.example/api/v1",
        value: input?.value ?? { message: "code-mode" },
        delayMs: input?.delayMs ?? 5_000,
      });
      return { agent: this.name, operation, value };
    } catch (error) {
      return { agent: this.name, operation, error: wireError(error) };
    } finally {
      if (operation !== "wait") worker.dispose();
    }
  }

  /**
   * Execute the pinned Computer Worker JavaScript backend in a fresh loaded
   * worker. The default module exercises a Workspace-backed sibling import,
   * structured input/output, and the explicit library capability sideband.
   * This fixture intentionally drains stdio rather than exporting a stream.
   */
  async javascript(input) {
    const name = input?.name;
    if (typeof name !== "string" || !AGENT_NAMES.has(name)) {
      throw new TypeError("javascript requires one of the pinned agent names");
    }
    const operation = input?.operation ?? "run";
    if (operation !== "run" && operation !== "cancel" &&
        operation !== "loader-modules") {
      throw new TypeError(
        "javascript operation must be run, cancel, or loader-modules",
      );
    }
    if (operation === "loader-modules") return this.loaderModules(input);
    await this.setName(name);

    const workspace = await getWorkspace(this);
    if (this.env?.LOADER === undefined) {
      throw new Error(
        "Worker JavaScript backend is unavailable; set CELLD_WORKER_LOADER=LOADER",
      );
    }
    const id = typeof input?.id === "string" && input.id.length > 0
      ? input.id
      : `conformance-javascript-${crypto.randomUUID()}`;
    const source = typeof input?.source === "string"
      ? input.source
      : operation === "cancel"
        ? "export default async () => { await new Promise(() => {}); }"
        : DEFAULT_JAVASCRIPT_SOURCE;

    if (input?.source === undefined) {
      await workspace.fs.mkdir("/workspace", { recursive: true });
      await workspace.fs.writeFile(
        "/workspace/helper.js",
        "export const suffix = \":sibling\";\n",
      );
      await workspace.fs.writeFile(
        "/workspace/javascript-input.txt",
        "workspace\n",
      );
    }

    const execution = await workspace.runtime.exec(source, {
      id,
      backend: "worker-javascript",
      cwd: "/workspace",
      encoding: "utf8",
      input: input?.input ?? { name, sequence: [1, 2, 3] },
      timeoutMs: input?.timeoutMs,
    });
    if (operation === "cancel") {
      await workspace.runtime.killExec(id, {
        backend: "worker-javascript",
        signal: "SIGTERM",
      });
    }
    const result = await execution.result();
    return {
      agent: this.name,
      id,
      status: result.status,
      exitCode: result.exitCode,
      value: result.value ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Exercise the generic Worker Loader module seam used by the pinned
   * Computer backend. The Computer 0.2.1 backend accepts text-only configured
   * modules, so this focused mode verifies nested sibling resolution and the
   * loader's supported Wasm sideband without pretending the package exposes a
   * Workspace Wasm mount.
   */
  async loaderModules(input) {
    const name = input?.name;
    if (typeof name !== "string" || !AGENT_NAMES.has(name)) {
      throw new TypeError("loader-modules requires one of the pinned agent names");
    }
    await this.setName(name);
    const loader = this.env?.LOADER;
    if (!loader) {
      throw new Error(
        "Worker Loader is unavailable; set CELLD_WORKER_LOADER=LOADER",
      );
    }
    const worker = loader.load({
      mainModule: "workspace/main.js",
      modules: {
        "workspace/main.js": LOADER_MODULE_SOURCE,
        "workspace/nested/loader-helper.js":
          "export const label = \":loader-sibling\";\n",
        "workspace/add.wasm": { wasm: WASM_ADD },
      },
      compatibilityDate: "2026-01-01",
      compatibilityFlags: ["js_rpc"],
      globalOutbound: null,
    });
    try {
      return {
        agent: this.name,
        value: await worker
          .getEntrypoint()
          .run(input?.input ?? { value: 40 }),
      };
    } finally {
      worker.dispose();
    }
  }

  /**
   * Persist the same message table used by the pinned AIChatAgent. The SDK's
   * private persistence helper remains untouched; this helper is only for the
   * explicit HTTP seam below, which is outside its WebSocket protocol.
   */
  async persistHttpMessages(messages) {
    this.sql`DELETE FROM cf_ai_chat_agent_messages`;
    for (const message of messages) {
      this.sql`
        INSERT INTO cf_ai_chat_agent_messages (id, message)
        VALUES (${message.id}, ${JSON.stringify(message)})
      `;
    }
    this.messages = messages;
  }

  async responseIdFor(messages) {
    const bytes = new TextEncoder().encode(JSON.stringify(messages));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `${this.name}-response-${hash}`;
  }

  responseState(responseId) {
    const rows = this.sql`
      SELECT response_id, status, cursor, messages
      FROM conformance_ai_responses
      WHERE response_id = ${responseId}
    `;
    const row = rows[0];
    return row
      ? {
          responseId: row.response_id,
          status: row.status,
          cursor: Number(row.cursor),
          messages: JSON.parse(row.messages),
        }
      : null;
  }

  responseChunks(responseId, after = 0) {
    return this.sql`
      SELECT sequence, chunk
      FROM conformance_ai_response_chunks
      WHERE response_id = ${responseId} AND sequence > ${after}
      ORDER BY sequence
    `.map((row) => ({ sequence: Number(row.sequence), bytes: chunkBytes(row.chunk) }));
  }

  responseContent(responseId) {
    const chunks = this.responseChunks(responseId, 0).map((row) => row.bytes);
    const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  ensureResponse(responseId, messages) {
    this.sql`
      INSERT OR IGNORE INTO conformance_ai_responses
        (response_id, status, cursor, messages, lease, lease_until)
      VALUES (${responseId}, 'streaming', 0, ${JSON.stringify(messages)}, NULL, 0)
    `;
  }

  claimResponse(responseId) {
    const lease = crypto.randomUUID();
    const now = Date.now();
    const rows = this.sql`
      UPDATE conformance_ai_responses
      SET lease = ${lease}, lease_until = ${now + 30_000}
      WHERE response_id = ${responseId} AND status = 'streaming'
        AND (lease IS NULL OR lease_until <= ${now})
      RETURNING response_id
    `;
    if (rows.length === 0) {
      throw new Error("AI response already has an active resume lease");
    }
    return lease;
  }

  releaseResponse(responseId, lease) {
    this.sql`
      UPDATE conformance_ai_responses
      SET lease = NULL, lease_until = 0
      WHERE response_id = ${responseId} AND lease = ${lease}
    `;
  }

  renewResponse(responseId, lease) {
    const rows = this.sql`
      UPDATE conformance_ai_responses
      SET lease_until = ${Date.now() + 30_000}
      WHERE response_id = ${responseId} AND status = 'streaming' AND lease = ${lease}
      RETURNING response_id
    `;
    return rows.length > 0;
  }

  startLeaseRenewal(responseId, lease) {
    let stopped = false;
    let timer;
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        if (stopped) return;
        if (!this.renewResponse(responseId, lease)) {
          stopped = true;
          return;
        }
        schedule();
      }, 10_000);
    };
    schedule();
    return {
      stop() {
        stopped = true;
        clearTimeout(timer);
      },
    };
  }

  async providerResponse(messages, responseId, after) {
    const providerUrl = this.env?.MODEL_PROVIDER_URL;
    if (typeof providerUrl !== "string" || providerUrl.length === 0) {
      throw new Error(
        "AIChatAgent requires the MODEL_PROVIDER_URL HTTP deployment capability",
      );
    }
    const providerResponse = await fetch(providerUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-celld-response-id": responseId,
        "x-celld-resume-after": String(after),
      },
      body: JSON.stringify({ model: MODEL, messages }),
    });
    if (!providerResponse.ok) {
      throw new Error(
        `HTTP model provider returned status ${providerResponse.status}`,
      );
    }
    if (!providerResponse.body) {
      throw new Error("HTTP model provider returned no response stream");
    }
    if (providerResponse.headers.get("x-celld-stream-format") !== "ndjson-v1") {
      throw new Error("HTTP model provider returned an unsupported stream format");
    }
    return providerResponse;
  }

  async responseStream(responseId, messages, after, lease, renewal, providerResponse, prefix, onFinish) {
    const agent = this;
    let next = after;
    let reader;
    let cancelled = false;
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (const stored of prefix) {
            if (cancelled) return;
            controller.enqueue(stored.bytes);
          }
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          let pending = "";
          const consumeFrames = (text) => {
            pending += text;
            for (;;) {
              const newline = pending.indexOf("\n");
              if (newline < 0) return;
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              if (!line) continue;
              const frame = JSON.parse(line);
              if (frame.version !== 1 || !Number.isSafeInteger(frame.sequence) ||
                  typeof frame.text !== "string" || frame.sequence !== next + 1) {
                throw new Error("HTTP model provider returned an invalid stream frame");
              }
              const bytes = encoder.encode(frame.text);
              const claimed = agent.sql`
                SELECT response_id FROM conformance_ai_responses
                WHERE response_id = ${responseId} AND lease = ${lease}
              `;
              if (claimed.length === 0) {
                throw new Error("AI response resume lease was lost");
              }
              // Checkpoint each framed provider chunk before exposing it. A
              // new activation can replay every acknowledged cursor from SQL.
              next = frame.sequence;
              agent.sql`
                INSERT OR REPLACE INTO conformance_ai_response_chunks
                  (response_id, sequence, chunk)
                VALUES (${responseId}, ${next}, ${encodeChunk(bytes)})
              `;
              const updated = agent.sql`
                UPDATE conformance_ai_responses SET cursor = ${next}
                WHERE response_id = ${responseId} AND lease = ${lease}
                RETURNING response_id
              `;
              if (updated.length === 0) {
                throw new Error("AI response resume lease was lost");
              }
              controller.enqueue(bytes);
            }
          };
          reader = providerResponse.body.getReader();
          while (!cancelled) {
            const result = await reader.read();
            if (result.done) break;
            consumeFrames(decoder.decode(result.value, { stream: true }));
          }
          consumeFrames(decoder.decode());
          if (pending.trim() !== "") {
            throw new Error("HTTP model provider returned a truncated stream frame");
          }
          if (cancelled) return;
          const stillClaimed = agent.sql`
            SELECT response_id FROM conformance_ai_responses
            WHERE response_id = ${responseId} AND lease = ${lease}
          `;
          if (stillClaimed.length === 0) {
            throw new Error("AI response resume lease was lost");
          }
          const responseMessages = [{
            id: responseId,
            role: "assistant",
            parts: [{
              type: "text",
              text: agent.responseContent(responseId),
            }],
          }];
          // Persist the final assistant message before closing the public
          // stream. The live-fleet output gate still owns acknowledgement and
          // replication timing; this seam only proves local ordering/resume.
          await onFinish({ response: { messages: responseMessages } });
          agent.sql`
            UPDATE conformance_ai_responses SET status = 'complete', cursor = ${next}
            WHERE response_id = ${responseId} AND lease = ${lease}
          `;
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          renewal.stop();
          agent.releaseResponse(responseId, lease);
        }
      },
      cancel() {
        cancelled = true;
        void reader?.cancel();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": CHAT_CONTENT_TYPE,
        "x-celld-response-id": responseId,
        "x-celld-response-cursor": String(next),
        "x-celld-response-status": "streaming",
      },
    });
  }

  async resumeResponse(responseId, after, onFinish) {
    const state = this.responseState(responseId);
    if (!state) throw new InvalidChatRequestError("unknown response cursor");
    if (!Number.isSafeInteger(after) || after < 0 || after > state.cursor) {
      throw new InvalidChatRequestError("response cursor is outside the durable range");
    }
    const prefix = this.responseChunks(responseId, after);
    if (state.status === "complete") {
      return new Response(byteStream(prefix.map((row) => row.bytes)), {
        headers: {
          "content-type": CHAT_CONTENT_TYPE,
          "x-celld-response-id": responseId,
          "x-celld-response-cursor": String(state.cursor),
          "x-celld-response-status": "complete",
        },
      });
    }
    const lease = this.claimResponse(responseId);
    const renewal = this.startLeaseRenewal(responseId, lease);
    try {
      const providerResponse = await this.providerResponse(
        state.messages,
        responseId,
        state.cursor,
      );
      return this.responseStream(
        responseId,
        state.messages,
        state.cursor,
        lease,
        renewal,
        providerResponse,
        prefix,
        onFinish,
      );
    } catch (error) {
      renewal.stop();
      this.releaseResponse(responseId, lease);
      throw error;
    }
  }

  /**
   * Ask the deployment-owned HTTP model provider. Every provider chunk is
   * checkpointed in the Agent cell before it is exposed. A disconnected
   * caller can use `/conformance/resume/<name>?response=...&after=...` after
   * activation to replay stored chunks and continue the provider stream.
   */
  async onChatMessage(onFinish) {
    const responseId = await this.responseIdFor(this.messages);
    const state = this.responseState(responseId);
    if (state) {
      return this.resumeResponse(responseId, 0, onFinish);
    }
    this.ensureResponse(responseId, this.messages);
    return this.resumeResponse(responseId, 0, onFinish);
  }

  async chatRequest(request) {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, { status: 405 });
    }
    const messages = autoTransformMessages(await requestMessagesFrom(request));
    const responseId = await this.responseIdFor(messages);
    const existing = this.responseState(responseId);
    if (existing) {
      this.messages = existing.messages;
    } else {
      await this.persistHttpMessages(messages);
    }
    return this.onChatMessage(async ({ response }) => {
      await this.persistHttpMessages([...messages, ...response.messages]);
    });
  }

  async resumeRequest(request) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, { status: 405 });
    }
    const url = new URL(request.url);
    const responseId = url.searchParams.get("response");
    if (!responseId) {
      throw new InvalidChatRequestError("resume requires a response id");
    }
    const state = this.responseState(responseId);
    if (!state) throw new InvalidChatRequestError("unknown response cursor");
    if (url.searchParams.get("status") === "1") {
      return json({
        response: responseId,
        status: state.status,
        cursor: state.cursor,
      });
    }
    const after = Number(url.searchParams.get("after") ?? "0");
    if (!Number.isSafeInteger(after)) {
      throw new InvalidChatRequestError("resume requires an integer response cursor");
    }
    return this.resumeResponse(responseId, after, async ({ response }) => {
      await this.persistHttpMessages([...state.messages, ...response.messages]);
    });
  }

  async adapterRequest(request) {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, { status: 405 });
    }
    if (!this.env?.AI || typeof this.env.AI.run !== "function") {
      throw new Error(
        "AI adapter deployment capability is missing; declare the AI binding and set CELLD_AI_URL",
      );
    }
    const messages = await requestMessagesFrom(request);
    return json({
      adapter: "http-ai",
      result: await this.env.AI.run(MODEL, { messages }),
    });
  }

  async onRequest(request) {
    const pathname = new URL(request.url).pathname;
    try {
      if (pathname.endsWith("/chat")) return await this.chatRequest(request);
      if (pathname.endsWith("/resume")) return await this.resumeRequest(request);
      if (pathname.endsWith("/ai-adapter")) return await this.adapterRequest(request);
    } catch (error) {
      const message = safeErrorMessage(error);
      const invalid = error instanceof InvalidChatRequestError;
      const missing = /deployment capability|CELLD_AI_URL/.test(message);
      return json({
        error: invalid
          ? "invalid_request"
          : missing ? "missing_deployment_capability" : "model_provider_error",
        message,
      }, { status: invalid ? 400 : missing ? 503 : 502 });
    }
    return super.onRequest(request);
  }
}

function routeNamedAgent(request, env, name, suffix) {
  const target = new URL(request.url);
  target.pathname = `/agents/agents/${name}/${suffix}`;
  return routeAgentRequest(new Request(target, request), env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/conformance/names") {
      const results = await Promise.all(
        [...AGENT_NAMES].map(async (name) => {
          const agent = await getAgentByName(env.agents, name);
          return agent.conformance({ name });
        }),
      );
      return json({ results });
    }

    const name =
      url.pathname.startsWith("/conformance/call/")
        ? agentNameFromPath(url.pathname)
        : null;
    if (name) {
      const agent = await getAgentByName(env.agents, name);
      return json(await agent.conformance({ name }));
    }

    const stateMatch = url.pathname.match(/^\/conformance\/state\/([^/]+)$/);
    if (stateMatch) {
      const stateName = AGENT_NAMES.has(stateMatch[1]) ? stateMatch[1] : null;
      if (!stateName) return json({ error: "unknown_agent" }, { status: 404 });
      if (!["GET", "POST"].includes(request.method)) {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      const agent = await getAgentByName(env.agents, stateName);
      const input = request.method === "POST"
        ? { ...(await request.json()), name: stateName, operation: "write" }
        : { name: stateName, operation: "read" };
      return json(await agent.stateAndSql(input));
    }

    const sessionMatch = url.pathname.match(/^\/conformance\/session\/([^/]+)$/);
    if (sessionMatch) {
      const stateName = AGENT_NAMES.has(sessionMatch[1]) ? sessionMatch[1] : null;
      if (!stateName) return json({ error: "unknown_agent" }, { status: 404 });
      if (request.method !== "GET") {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      const agent = await getAgentByName(env.agents, stateName);
      return json(await agent.sessionStatus({ name: stateName }));
    }

    const scheduleMatch = url.pathname.match(/^\/conformance\/schedule\/([^/]+)$/);
    if (scheduleMatch) {
      const stateName = AGENT_NAMES.has(scheduleMatch[1]) ? scheduleMatch[1] : null;
      if (!stateName) return json({ error: "unknown_agent" }, { status: 404 });
      if (!["GET", "POST"].includes(request.method)) {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      const agent = await getAgentByName(env.agents, stateName);
      if (request.method === "POST") {
        return json(await agent.scheduleWork({
          ...(await request.json()),
          name: stateName,
        }));
      }
      return json(await agent.scheduleStatus({ name: stateName }));
    }

    const workspaceMatch = url.pathname.match(/^\/conformance\/workspace\/([^/]+)$/);
    if (workspaceMatch) {
      const workspaceName = AGENT_NAMES.has(workspaceMatch[1])
        ? workspaceMatch[1]
        : null;
      if (!workspaceName) return json({ error: "unknown_agent" }, { status: 404 });
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      const agent = await getAgentByName(env.agents, workspaceName);
      const body = await request.json();
      const input = body && typeof body === "object" && !Array.isArray(body)
        ? body
        : {};
      return json(await agent.workspace({ ...input, name: workspaceName }));
    }

    const shellMatch = url.pathname.match(/^\/conformance\/shell\/([^/]+)$/);
    if (shellMatch) {
      const shellName = AGENT_NAMES.has(shellMatch[1]) ? shellMatch[1] : null;
      if (!shellName) return json({ error: "unknown_agent" }, { status: 404 });
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      const agent = await getAgentByName(env.agents, shellName);
      const body = await request.json();
      const input = body && typeof body === "object" && !Array.isArray(body)
        ? body
        : {};
      try {
        return json(await agent.shell({ ...input, name: shellName }));
      } catch (error) {
        const message = safeErrorMessage(error);
        const invalid = /requires|must be|non-empty/.test(message);
        const missing = /LOADER Worker Loader/.test(message);
        return json({
          error: invalid ? "invalid_shell_request"
            : missing ? "missing_deployment_capability" : "shell_execution_error",
          message,
        }, { status: invalid ? 400 : missing ? 503 : 502 });
      }
    }

    const codeModeMatch = url.pathname.match(/^\/conformance\/code-mode\/([^/]+)$/);
    if (codeModeMatch) {
      const codeModeName = AGENT_NAMES.has(codeModeMatch[1])
        ? codeModeMatch[1]
        : null;
      if (!codeModeName) return json({ error: "unknown_agent" }, { status: 404 });
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      const agent = await getAgentByName(env.agents, codeModeName);
      try {
        const body = await request.json();
        const input = body && typeof body === "object" && !Array.isArray(body)
          ? body
          : {};
        return json(await agent.codeMode({ ...input, name: codeModeName }));
      } catch (error) {
        return json({
          error: "code_mode_error",
          ...wireError(error),
        }, { status: 502 });
      }
    }

    const javascriptMatch = url.pathname.match(/^\/conformance\/javascript\/([^/]+)$/);
    if (javascriptMatch) {
      const javascriptName = AGENT_NAMES.has(javascriptMatch[1])
        ? javascriptMatch[1]
        : null;
      if (!javascriptName) return json({ error: "unknown_agent" }, { status: 404 });
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      const agent = await getAgentByName(env.agents, javascriptName);
      try {
        const body = await request.json();
        const input = body && typeof body === "object" && !Array.isArray(body)
          ? body
          : {};
        return json(await agent.javascript({ ...input, name: javascriptName }));
      } catch (error) {
        return json({
          error: "javascript_backend_error",
          message: safeErrorMessage(error),
        }, { status: 502 });
      }
    }

    for (const [prefix, suffix] of [
      ["/conformance/chat/", "chat"],
      ["/conformance/resume/", "resume"],
      ["/conformance/ai-adapter/", "ai-adapter"],
      ["/conformance/messages/", "get-messages"],
    ]) {
      if (!url.pathname.startsWith(prefix)) continue;
      const name = url.pathname.slice(prefix.length);
      if (!AGENT_NAMES.has(name)) return json({ error: "unknown_agent" }, { status: 404 });
      return routeNamedAgent(request, env, name, suffix);
    }

    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    return json({
      error: "not_found",
      expected: [
        "/conformance/call/alpha",
        "/conformance/call/beta",
        "/conformance/names",
        "/conformance/state/alpha",
        "/conformance/state/beta",
        "/conformance/session/alpha",
        "/conformance/session/beta",
        "/conformance/schedule/alpha",
        "/conformance/schedule/beta",
        "/conformance/workspace/alpha",
        "/conformance/workspace/beta",
        "/conformance/shell/alpha",
        "/conformance/shell/beta",
        "/conformance/javascript/alpha",
        "/conformance/javascript/beta",
        "/conformance/code-mode/alpha",
        "/conformance/code-mode/beta",
        "/conformance/chat/alpha",
        "/conformance/resume/alpha?response=<id>&after=<cursor>",
        "/conformance/messages/alpha",
        "/conformance/ai-adapter/alpha",
        "/agents/agents/alpha",
        "/agents/agents/beta",
      ],
    }, { status: 404 });
  },
};
