import {
  Agent,
  getAgentByName,
  routeAgentRequest,
} from "@cloudflare/agents";

const AGENT_NAMES = new Set(["alpha", "beta"]);

function agentNameFromPath(pathname) {
  const name = pathname.slice("/conformance/call/".length);
  return AGENT_NAMES.has(name) ? name : null;
}

function json(value, init) {
  return Response.json(value, init);
}

/**
 * Smallest source-unmodified Agent used by the celld compatibility fixture.
 * The callable method deliberately returns nested cloneable data rather than
 * a class, function, stream, or other live RPC capability.
 */
export class ConformanceAgent extends Agent {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql`
      CREATE TABLE IF NOT EXISTS conformance_agent_records (
        id TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        revision INTEGER NOT NULL
      )
    `;
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
        "/agents/agents/alpha",
        "/agents/agents/beta",
      ],
    }, { status: 404 });
  },
};
