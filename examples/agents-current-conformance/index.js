import { createOpenAI } from "@ai-sdk/openai";
import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
} from "ai";
import { getAgentByName, routeAgentRequest } from "agents";
import { z } from "zod";

const AGENT_NAMES = new Set(["alpha", "beta"]);
const CURRENT_ROUTE_PREFIX = "/agents/current-conformance-agent/";
const CONFORMANCE_MODEL = "llama-swap/Qwen3.6-35B-A3B";
const MAX_MEMORY_LENGTH = 500;
const MAX_MEMORIES = 20;
const MAX_SUMMARY_MEMORIES = 10;
const MAX_REMINDER_MESSAGE_LENGTH = 500;
const MAX_REMINDER_DELAY_SECONDS = 3_600;
const MAX_PENDING_REMINDERS = 20;
const MAX_REMINDER_HISTORY = 50;
const MAX_SCHEDULE_ID_LENGTH = 64;
const memoryInputSchema = z.object({
  fact: z.string().trim().min(1).max(MAX_MEMORY_LENGTH),
}).strict();
const scheduleReminderInputSchema = z.object({
  message: z.string().trim().min(1).max(MAX_REMINDER_MESSAGE_LENGTH),
  delaySeconds: z.number().int().min(1).max(MAX_REMINDER_DELAY_SECONDS),
}).strict();
const cancelReminderInputSchema = z.object({
  id: z.string().trim().min(1).max(MAX_SCHEDULE_ID_LENGTH)
    .regex(/^[a-zA-Z0-9_-]+$/),
}).strict();
const reminderPayloadSchema = scheduleReminderInputSchema.extend({
  reminderId: z.string().uuid(),
}).strict();
const emptyToolInputSchema = z.object({}).strict();

const PUBLIC_PROVIDER_ERRORS = Object.freeze({
  interrupted: "chat_stream_interrupted",
  invalid: "chat_provider_invalid_output",
  missing: "chat_provider_capability_missing",
  rejected: "chat_provider_rejected",
  unavailable: "chat_provider_unavailable",
});
const PUBLIC_PROVIDER_ERROR_CODES = new Set(Object.values(PUBLIC_PROVIDER_ERRORS));

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
    memories: [],
    reminders: 0,
    lastReminder: null,
    reminderItems: [],
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
  if (name.length === 0 || /InvalidResponse|JSONParse|InvalidStream|NoContent|InvalidToolInput/.test(name)) {
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

function durableChatOutcome(result) {
  if (result.status === "completed") return { status: "completed" };
  if (result.status === "aborted") {
    return { status: "failed", code: PUBLIC_PROVIDER_ERRORS.interrupted };
  }
  return {
    status: "failed",
    code: PUBLIC_PROVIDER_ERROR_CODES.has(result.error)
      ? result.error
      : PUBLIC_PROVIDER_ERRORS.unavailable,
  };
}

function finalizeChatMessage(message, outcome) {
  return {
    ...message,
    metadata: {
      ...(message.metadata && typeof message.metadata === "object" ? message.metadata : {}),
      celldStream: outcome,
    },
    parts: message.parts.map((part) =>
      part && typeof part === "object" && part.state === "streaming"
        ? { ...part, state: "done" }
        : part),
  };
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
    this.sql`
      CREATE TABLE IF NOT EXISTS current_conformance_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fact TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS current_conformance_reminders (
        reminder_id TEXT PRIMARY KEY NOT NULL,
        schedule_id TEXT UNIQUE,
        message TEXT NOT NULL,
        delay_seconds INTEGER NOT NULL,
        status TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        completed_at INTEGER,
        cancelled_at INTEGER
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
          ...(Number.isSafeInteger(persisted.reminders) ? { reminders: persisted.reminders } : {}),
          ...(typeof persisted.lastReminder === "string" ? { lastReminder: persisted.lastReminder } : {}),
          ...(Array.isArray(persisted.reminderItems) ? { reminderItems: persisted.reminderItems } : {}),
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
      memories: this.listMemories().memories,
      reminders: this.listReminders().reminders,
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
      tools: this.agentTools(),
      stopWhen: stepCountIs(5),
    });
    return result.toUIMessageStreamResponse({ onError: publicProviderError });
  }

  async onChatResponse(result) {
    const index = this.messages.findIndex((message) => message.id === result.message.id);
    if (index < 0) return;
    const messages = [...this.messages];
    messages[index] = finalizeChatMessage(result.message, durableChatOutcome(result));
    await this.persistMessages(messages);
  }

  listMemories(limit = MAX_MEMORIES) {
    this.ensureTables();
    const memories = this.sql`
      SELECT id, fact, created_at
      FROM current_conformance_memories
      ORDER BY id
      LIMIT ${limit}
    `.map((row) => ({
      id: Number(row.id),
      fact: row.fact,
      createdAt: Number(row.created_at),
    }));
    return { memories, total: memories.length };
  }

  rememberFact(input) {
    const { fact } = memoryInputSchema.parse(input);
    const current = this.listMemories();
    if (current.total >= MAX_MEMORIES && !current.memories.some((memory) => memory.fact === fact)) {
      throw new RangeError(`an Agent can retain at most ${MAX_MEMORIES} explicit memories`);
    }
    this.sql`
      INSERT OR IGNORE INTO current_conformance_memories (fact, created_at)
      VALUES (${fact}, ${Date.now()})
    `;
    const result = this.listMemories();
    const state = this.state && typeof this.state === "object"
      ? this.state
      : initialState(this.name);
    this.setState({ ...state, agent: this.name, memories: result.memories });
    return { memory: result.memories.find((memory) => memory.fact === fact), total: result.total };
  }

  summarizeMemories() {
    this.ensureTables();
    const memories = this.sql`
      SELECT fact
      FROM current_conformance_memories
      ORDER BY id DESC
      LIMIT ${MAX_SUMMARY_MEMORIES}
    `.map((row) => row.fact).reverse();
    return {
      summary: memories.length === 0 ? "Nothing has been remembered yet." : memories.join("; "),
      memories: memories.length,
    };
  }

  agentTools() {
    return {
      rememberFact: tool({
        description: "Remember one explicit fact in the current named Agent.",
        inputSchema: memoryInputSchema,
        execute: async (input) => this.rememberFact(input),
      }),
      listMemories: tool({
        description: "List explicit facts stored by the current named Agent.",
        inputSchema: emptyToolInputSchema,
        execute: async () => this.listMemories(),
      }),
      summarizeMemories: tool({
        description: "Summarize only the current named Agent's explicit facts.",
        inputSchema: emptyToolInputSchema,
        execute: async () => this.summarizeMemories(),
      }),
      scheduleReminder: tool({
        description: "Schedule one durable reminder in the current named Agent.",
        inputSchema: scheduleReminderInputSchema,
        execute: async (input) => this.scheduleReminder(input),
      }),
      listReminders: tool({
        description: "List pending, cancelled, and completed reminders in the current named Agent.",
        inputSchema: emptyToolInputSchema,
        execute: async () => this.listReminders(),
      }),
      cancelReminder: tool({
        description: "Cancel a pending reminder owned by the current named Agent.",
        inputSchema: cancelReminderInputSchema,
        execute: async (input) => this.cancelReminder(input),
      }),
    };
  }

  listReminders() {
    this.ensureTables();
    const reminders = this.sql`
      SELECT schedule_id, message, delay_seconds, status, scheduled_at,
             due_at, completed_at, cancelled_at
      FROM current_conformance_reminders
      WHERE status != 'scheduling'
      ORDER BY
        CASE status WHEN 'pending' THEN 0 ELSE 1 END,
        CASE status
          WHEN 'pending' THEN due_at
          ELSE COALESCE(completed_at, cancelled_at, scheduled_at)
        END DESC
      LIMIT ${MAX_REMINDER_HISTORY}
    `.map((row) => ({
      id: row.schedule_id,
      message: row.message,
      delaySeconds: Number(row.delay_seconds),
      status: row.status,
      scheduledAt: Number(row.scheduled_at),
      dueAt: Number(row.due_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      cancelledAt: row.cancelled_at === null ? null : Number(row.cancelled_at),
    }));
    return {
      reminders,
      total: reminders.length,
      pending: reminders.filter((reminder) => reminder.status === "pending").length,
    };
  }

  syncReminderState(lastReminder = undefined) {
    const result = this.listReminders();
    const state = this.state && typeof this.state === "object"
      ? this.state
      : initialState(this.name);
    this.setState({
      ...state,
      agent: this.name,
      reminders: result.reminders.filter((reminder) => reminder.status === "completed").length,
      lastReminder: lastReminder ?? state.lastReminder ?? null,
      reminderItems: result.reminders,
    });
    return result;
  }

  pruneReminderHistory() {
    this.sql`
      DELETE FROM current_conformance_reminders
      WHERE status NOT IN ('scheduling', 'pending')
        AND reminder_id NOT IN (
          SELECT reminder_id
          FROM current_conformance_reminders
          WHERE status NOT IN ('scheduling', 'pending')
          ORDER BY COALESCE(completed_at, cancelled_at, scheduled_at) DESC
          LIMIT ${MAX_REMINDER_HISTORY}
        )
    `;
  }

  async scheduleReminder(input) {
    const { message, delaySeconds } = scheduleReminderInputSchema.parse(input);
    const duplicate = this.sql`
      SELECT reminder_id, schedule_id
      FROM current_conformance_reminders
      WHERE message = ${message}
        AND delay_seconds = ${delaySeconds}
        AND status IN ('scheduling', 'pending')
      ORDER BY scheduled_at
      LIMIT 1
    `[0];
    if (duplicate?.schedule_id) {
      const result = this.syncReminderState();
      return {
        reminder: result.reminders.find((reminder) => reminder.id === duplicate.schedule_id),
        duplicate: true,
      };
    }
    const pendingRows = this.sql`
      SELECT COUNT(*) AS count
      FROM current_conformance_reminders
      WHERE status IN ('scheduling', 'pending')
    `;
    const current = { pending: Number(pendingRows[0]?.count ?? 0) };
    if (!duplicate && current.pending >= MAX_PENDING_REMINDERS) {
      throw new RangeError("reminder_pending_limit_reached");
    }
    const reminderId = duplicate?.reminder_id ?? crypto.randomUUID();
    if (!duplicate) {
      const scheduledAt = Date.now();
      this.sql`
        INSERT INTO current_conformance_reminders
          (reminder_id, message, delay_seconds, status, scheduled_at, due_at)
        VALUES (
          ${reminderId}, ${message}, ${delaySeconds}, 'scheduling',
          ${scheduledAt}, ${scheduledAt + delaySeconds * 1_000}
        )
      `;
    }
    const schedule = await this.schedule(delaySeconds, "deliverReminder", {
      reminderId,
      message,
      delaySeconds,
    }, { idempotent: true });
    this.sql`
      UPDATE current_conformance_reminders
      SET schedule_id = ${schedule.id}, status = 'pending', due_at = ${schedule.time * 1_000}
      WHERE reminder_id = ${reminderId} AND status = 'scheduling'
    `;
    const result = this.syncReminderState();
    return {
      reminder: result.reminders.find((reminder) => reminder.id === schedule.id),
      duplicate: Boolean(duplicate),
    };
  }

  async cancelReminder(input) {
    const { id } = cancelReminderInputSchema.parse(input);
    const reminder = this.sql`
      SELECT schedule_id
      FROM current_conformance_reminders
      WHERE schedule_id = ${id} AND status = 'pending'
    `[0];
    if (!reminder) throw new RangeError("reminder_not_found_for_agent");
    if (!await this.cancelSchedule(id)) {
      throw new RangeError("reminder_no_longer_pending");
    }
    this.sql`
      UPDATE current_conformance_reminders
      SET status = 'cancelled', cancelled_at = ${Date.now()}
      WHERE schedule_id = ${id} AND status = 'pending'
    `;
    this.pruneReminderHistory();
    const result = this.syncReminderState();
    return {
      reminder: result.reminders.find((item) => item.id === id),
      cancelled: true,
    };
  }

  deliverReminder(payload) {
    const { reminderId, message } = reminderPayloadSchema.parse(payload);
    const reminder = this.sql`
      SELECT schedule_id
      FROM current_conformance_reminders
      WHERE reminder_id = ${reminderId} AND status = 'pending'
    `[0];
    if (!reminder) return;
    this.sql`
      UPDATE current_conformance_reminders
      SET status = 'completed', completed_at = ${Date.now()}
      WHERE reminder_id = ${reminderId} AND status = 'pending'
    `;
    this.pruneReminderHistory();
    this.syncReminderState(message);
  }

  resetMemories() {
    this.ensureTables();
    this.sql`DELETE FROM current_conformance_memories`;
    const state = this.state && typeof this.state === "object"
      ? this.state
      : initialState(this.name);
    this.setState({ ...state, agent: this.name, memories: [] });
    return this.listMemories();
  }

  async resetReminders() {
    this.ensureTables();
    const pending = this.listReminders().reminders
      .filter((reminder) => reminder.status === "pending");
    await Promise.all(pending.map((reminder) => this.cancelSchedule(reminder.id)));
    this.sql`DELETE FROM current_conformance_reminders`;
    const state = this.state && typeof this.state === "object"
      ? this.state
      : initialState(this.name);
    this.setState({
      ...state,
      agent: this.name,
      reminders: 0,
      lastReminder: null,
      reminderItems: [],
    });
    return this.listReminders();
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

    if (url.pathname === "/current/memories/reset") {
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      const results = await Promise.all(
        [...AGENT_NAMES].map(async (name) => {
          const agent = await namedAgent(env, name);
          return { name, ...(await agent.resetMemories()) };
        }),
      );
      return json({ results });
    }

    if (url.pathname === "/current/reminders/reset") {
      if (request.method !== "POST") {
        return json({ error: "method_not_allowed" }, { status: 405 });
      }
      const results = await Promise.all(
        [...AGENT_NAMES].map(async (name) => {
          const agent = await namedAgent(env, name);
          return { name, ...(await agent.resetReminders()) };
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
