import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const MAX_BODY_BYTES = 1024 * 1024;

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.parts)) return "";
  return message.parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function responseText(messages) {
  const lastUser = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((message) => message?.role === "user");
  return `deterministic response for ${messageText(lastUser) || "(empty)"}`;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

/**
 * Deterministic, credential-free HTTP provider used by the conformance fixture.
 * It deliberately writes the text in multiple chunks and never logs the
 * request, so tests can observe complete streaming without exposing payloads.
 */
export function createModelProviderServer() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      return sendJson(response, 200, { ok: true });
    }
    if (request.method !== "POST" || !["/v1/chat", "/v1/ai"].includes(request.url)) {
      return sendJson(response, 404, { error: "not_found" });
    }

    let payload;
    try {
      payload = await readJson(request);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }

    if (request.url === "/v1/ai") {
      const messages = payload.input?.messages;
      return sendJson(response, 200, {
        model: payload.model,
        response: responseText(messages),
        complete: true,
      });
    }

    const text = responseText(payload.messages);
    const chunks = [
      "deterministic ",
      "response for ",
      text.slice("deterministic response for ".length),
    ];
    const frames = chunks.map((chunk, index) => JSON.stringify({
      version: 1,
      sequence: index + 1,
      text: chunk,
    }) + "\n");
    const after = Number(request.headers["x-celld-resume-after"] ?? "0");
    response.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-celld-provider": "deterministic",
      "x-celld-stream-format": "ndjson-v1",
    });
    for (const frame of frames.slice(Number.isSafeInteger(after) && after >= 0 ? after : 0)) {
      // Deliberately split every application frame across two writes. The
      // client must parse ndjson framing rather than treating read() chunks as
      // provider sequence boundaries.
      const midpoint = Math.max(1, Math.floor(frame.length / 2));
      response.write(frame.slice(0, midpoint));
      await new Promise((resolve) => setImmediate(resolve));
      response.write(frame.slice(midpoint));
      await new Promise((resolve) => setImmediate(resolve));
    }
    response.end();
  });
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const host = option("--host", DEFAULT_HOST);
  const port = Number(option("--port", DEFAULT_PORT));
  const server = createModelProviderServer();
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`deterministic model provider listening on http://${address.address}:${address.port}`);
  });
}
