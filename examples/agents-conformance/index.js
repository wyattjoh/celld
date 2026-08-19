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

    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    return json({
      error: "not_found",
      expected: [
        "/conformance/call/alpha",
        "/conformance/call/beta",
        "/conformance/names",
        "/agents/agents/alpha",
        "/agents/agents/beta",
      ],
    }, { status: 404 });
  },
};
