function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function deliveries(env) {
  return env.DELIVERIES.get(env.DELIVERIES.idFromName("log"));
}

function queueBody(body, contentType) {
  if (contentType === "bytes") return Uint8Array.from(body);
  return body;
}

function recordedBody(body) {
  if (body instanceof Uint8Array) {
    return { contentType: "bytes", body: Array.from(body) };
  }
  if (typeof body === "string") return { contentType: "text", body };
  return { contentType: "json", body };
}

/**
 * Durable delivery log shared by stateless fetch and queue-handler isolates.
 */
export class Deliveries {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/record") {
      const records = (await this.state.storage.get("records")) ?? [];
      records.push(await request.json());
      await this.state.storage.put("records", records);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname === "/reset") {
      await this.state.storage.deleteAll();
      return new Response(null, { status: 204 });
    }
    return json({ records: (await this.state.storage.get("records")) ?? [] });
  }
}

/**
 * Queue producer, push consumer, and delivery-log HTTP surface.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/deliveries") {
      return deliveries(env).fetch("http://deliveries/");
    }
    if (request.method === "POST" && url.pathname === "/reset") {
      return deliveries(env).fetch("http://deliveries/reset", { method: "POST" });
    }
    if (request.method === "POST" && url.pathname === "/send") {
      const { body, options = {} } = await request.json();
      await env.EVENTS.send(queueBody(body, options.contentType), options);
      return json({ queued: 1 }, 202);
    }
    if (request.method === "POST" && url.pathname === "/send-batch") {
      const { messages, options = {} } = await request.json();
      await env.EVENTS.sendBatch(messages.map((message) => ({
        ...message,
        body: queueBody(message.body, message.contentType),
      })), options);
      return json({ queued: messages.length }, 202);
    }
    return json({ error: "not_found" }, 404);
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const { contentType, body } = recordedBody(message.body);
      await deliveries(env).fetch("http://deliveries/record", {
        method: "POST",
        body: JSON.stringify({
          id: message.id,
          attempt: message.attempts,
          timestamp: message.timestamp.toISOString(),
          recordedAt: new Date().toISOString(),
          contentType,
          body,
        }),
      });

      if (message.body?.mode === "poison") {
        message.retry();
      } else if (
        message.body?.mode === "retry" &&
        message.attempts < message.body.until
      ) {
        message.retry();
      } else {
        message.ack();
      }
    }
  },
};
