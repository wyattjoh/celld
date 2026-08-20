import { createOpenAI } from "@ai-sdk/openai";
import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
} from "ai";
import { getAgentByName, routeAgentRequest } from "agents";

const AGENT_NAMES = new Set(["alpha", "beta"]);
const CURRENT_ROUTE_PREFIX = "/agents/current-conformance-agent/";
const CONFORMANCE_MODEL = "llama-swap/Qwen3.6-35B-A3B";
const PUBLIC_PROVIDER_ERRORS = Object.freeze({
  invalid: "chat_provider_invalid_output",
  missing: "chat_provider_capability_missing",
  rejected: "chat_provider_rejected",
  unavailable: "chat_provider_unavailable",
});

function json(value, init) {
  return Response.json(value, init);
}

function requireName(value, operation) {
  if (typeof value !== "string" || !AGENT_NAMES.has(value)) {
    throw new TypeError(`${operation} requires one of the pinned agent names`);
  }
  return value;
}

function initialState(name = null) {
  return {
    agent: name,
    messageCount: 0,
    connectionCount: 0,
    activationCount: 0,
    lastMessage: null,
    lastConnectionId: null,
  };
}

function messageValue(message) {
  if (typeof message !== "string") return "[binary]";
  try {
    const parsed = JSON.parse(message);
    return typeof parsed === "string"
      ? parsed
      : typeof parsed?.message === "string" ? parsed.message : message;
  } catch {
    return message;
  }
}

function modelGatewayBaseUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function publicProviderError(error) {
  const name = error instanceof Error ? error.name : "";
  if (/InvalidResponse|JSONParse|InvalidStream|NoContent/.test(name)) {
    return PUBLIC_PROVIDER_ERRORS.invalid;
  }
  const status = error && typeof error === "object" ? error.statusCode : undefined;
  if (Number.isSafeInteger(status) && status >= 400) {
    return PUBLIC_PROVIDER_ERRORS.rejected;
  }
  return PUBLIC_PROVIDER_ERRORS.unavailable;
}

function errorStreamResponse(code) {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute({ writer }) {
        writer.write({ type: "error", errorText: code });
      },
    }),
  });
}

/**
 * Source-unmodified current Agents SDK and durable chat target.
 *
 * The Agent uses the public AIChatAgent, getAgentByName, and routeAgentRequest
 * APIs. It streams through a credential-free OpenAI-compatible gateway and
 * leaves chat persistence to the package-owned durable message model.
 */
export class CurrentConformanceAgent extends AIChatAgent {
  initialState = initialState();

  ensureTables() {
    this.sql`
      CREATE TABLE IF NOT EXISTS current_conformance_state (
        id TEXT PRIMARY KEY NOT NULL,
        message_count INTEGER NOT NULL,
        connection_count INTEGER NOT NULL,
        last_message TEXT,
        last_connection_id TEXT
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS current_conformance_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL,
        message TEXT NOT NULL,
        message_count INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS current_conformance_records (
        id TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL,
        revision INTEGER NOT NULL
      )
    `;
  }

  durableState() {
    this.ensureTables();
    const persisted = this.state;
    const activationCount = Number.isSafeInteger(this.activationCount)
      ? this.activationCount
      : persisted?.activationCount;
    const userState = persisted && typeof persisted === "object"
      ? {
          ...(typeof persisted.value === "string" ? { value: persisted.value } : {}),
          ...(Number.isSafeInteger(persisted.revision) ? { revision: persisted.revision } : {}),
          ...(Number.isSafeInteger(activationCount) ? { activationCount } : {}),
        }
      : {};
    const rows = this.sql`
      SELECT message_count, connection_count, last_message, last_connection_id
      FROM current_conformance_state
      WHERE id = ${"default"}
    `;
    const row = rows[0];
    if (!row) return { ...initialState(this.name), ...userState };
    return {
      agent: this.name,
      messageCount: Number(row.message_count),
      connectionCount: Number(row.connection_count),
      lastMessage: row.last_message,
      lastConnectionId: row.last_connection_id,
      ...userState,
    };
  }

  persistState(state) {
    this.ensureTables();
    this.sql`
      INSERT OR REPLACE INTO current_conformance_state
        (id, message_count, connection_count, last_message, last_connection_id)
      VALUES (
        ${"default"}, ${state.messageCount}, ${state.connectionCount},
        ${state.lastMessage}, ${state.lastConnectionId}
      )
    `;
  }

  snapshot() {
    const state = this.durableState();
    return {
      agent: this.name,
      activeConnections: [...this.getConnections()].length,
      state,
      events: this.sql`
        SELECT sequence, connection_id, message, message_count
        FROM current_conformance_events
        ORDER BY sequence
      `,
      records: this.sql`
        SELECT id, value, revision
        FROM current_conformance_records
        ORDER BY id
      `,
    };
  }

  async onStart() {
    const state = this.state && typeof this.state === "object"
      ? this.state
      : initialState(this.name);
    this.activationCount = (state.activationCount ?? 0) + 1;
    this.setState({
      ...state,
      agent: this.name,
      activationCount: this.activationCount,
    });
  }

  async onChatMessage(_onFinish, options) {
    if (options?.body?.conformanceProviderMode === "missing") {
      return errorStreamResponse(PUBLIC_PROVIDER_ERRORS.missing);
    }
    const gatewayUrl = modelGatewayBaseUrl(this.env.MODEL_GATEWAY_URL);
    if (gatewayUrl === null || this.env.LLM_MODEL !== CONFORMANCE_MODEL) {
      return errorStreamResponse(PUBLIC_PROVIDER_ERRORS.missing);
    }

    const openai = createOpenAI({
      apiKey: "celld-conformance-placeholder",
      baseURL: `${gatewayUrl}/v1`,
    });
    const result = streamText({
      abortSignal: options?.abortSignal,
      model: openai.chat(CONFORMANCE_MODEL),
      maxRetries: 0,
      messages: await convertToModelMessages(this.messages),
    });
    return result.toUIMessageStreamResponse({ onError: publicProviderError });
  }

  async probe(input) {
    requireName(input?.name, "probe");
    return this.snapshot();
  }

  async readState(input) {
    requireName(input?.name, "readState");
    return this.snapshot();
  }

  async writeState(input) {
    const name = requireName(input?.name, "writeState");
    if (typeof input?.value !== "string" || !Number.isSafeInteger(input?.revision)) {
      throw new TypeError("writeState requires a string value and integer revision");
    }
    const current = this.state && typeof this.state === "object"
      ? this.state
      : initialState(name);
    this.setState({
      ...current,
      agent: name,
      value: input.value,
      revision: input.revision,
      ...(Number.isSafeInteger(this.activationCount)
        ? { activationCount: this.activationCount }
        : {}),
    });
    this.ensureTables();
    this.sql`
      INSERT OR REPLACE INTO current_conformance_records (id, value, revision)
      VALUES (${name}, ${input.value}, ${input.revision})
    `;
    return this.snapshot();
  }

  async onRequest(request) {
    const pathname = new URL(request.url).pathname;
    if (!pathname.endsWith("/status")) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, { status: 405 });
    }
    return json(this.snapshot());
  }

  onConnect(connection, ctx) {
    const state = this.durableState();
    const next = {
      ...state,
      connectionCount: state.connectionCount + 1,
      lastConnectionId: connection.id,
    };
    this.persistState(next);
    connection.setState({ messageCount: next.messageCount });
    connection.send(JSON.stringify({
      type: "current-conformance.connected",
      agent: this.name,
      connectionId: connection.id,
      requestPath: new URL(ctx.request.url).pathname,
      state: next,
    }));
  }

  onMessage(connection, message) {
    const value = messageValue(message);
    const state = this.durableState();
    const next = {
      ...state,
      messageCount: state.messageCount + 1,
      lastMessage: value,
      lastConnectionId: connection.id,
    };
    this.persistState(next);
    this.sql`
      INSERT INTO current_conformance_events (connection_id, message, message_count)
      VALUES (${connection.id}, ${value}, ${next.messageCount})
    `;
    connection.setState({ messageCount: next.messageCount });
    connection.send(JSON.stringify({
      type: "current-conformance.message",
      agent: this.name,
      connectionId: connection.id,
      state: next,
    }));
  }
}

async function namedAgent(env, name) {
  return getAgentByName(env.CurrentConformanceAgent, requireName(name, "namedAgent"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/current/names") {
      const results = await Promise.all(
        [...AGENT_NAMES].map(async (name) => {
          const agent = await namedAgent(env, name);
          return agent.probe({ name });
        }),
      );
      return json({ results });
    }

    const stateMatch = url.pathname.match(/^\/current\/state\/([^/]+)$/);
    if (stateMatch) {
      const name = requireName(stateMatch[1], "state");
      const agent = await namedAgent(env, name);
      if (request.method === "GET") return json(await agent.readState({ name }));
      if (request.method === "POST") {
        const body = await request.json();
        return json(await agent.writeState({ ...body, name }));
      }
      return json({ error: "method_not_allowed" }, { status: 405 });
    }

    const routed = await routeAgentRequest(request, env);
    if (routed) return routed;

    return json({
      error: "not_found",
      expected: [
        "/current/names",
        "/current/state/alpha",
        `${CURRENT_ROUTE_PREFIX}alpha/status`,
        `${CURRENT_ROUTE_PREFIX}beta/status`,
        `${CURRENT_ROUTE_PREFIX}<name> (WebSocket)`,
      ],
    }, { status: 404 });
  },
};
