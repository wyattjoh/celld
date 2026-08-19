import {
  Agent,
  getAgentByName,
  routeAgentRequest,
} from "@cloudflare/agents";
import { getWorkspace, withWorkspace } from "@cloudflare/computer";

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

function agentNameFromPath(pathname) {
  const name = pathname.slice("/conformance/call/".length);
  return AGENT_NAMES.has(name) ? name : null;
}

function json(value, init) {
  return Response.json(value, init);
}

/**
 * Smallest source-unmodified Agent used by the celld compatibility fixture.
 *
 * The mixin deliberately supplies no execution backend: this is the pinned
 * filesystem-only Computer seam. Its Workspace receives this Agent cell's
 * storage object, so the package's VFS tables share the cell's authoritative
 * SQLite database with Agent state and SQL.
 */
export class ConformanceAgent extends withWorkspace(
  Agent,
  (self) => ({ storage: self.ctx.storage }),
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
   * Agent cell. No Worker Loader, shell, or JavaScript backend is configured.
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

  onRequest(request) {
    return json({
      agent: this.name,
      path: new URL(request.url).pathname,
      surface: "routeAgentRequest",
    });
  }
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
      if (!(["GET", "POST"].includes(request.method))) {
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
        "/agents/agents/alpha",
        "/agents/agents/beta",
      ],
    }, { status: 404 });
  },
};
