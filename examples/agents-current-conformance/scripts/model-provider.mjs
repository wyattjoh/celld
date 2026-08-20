#!/usr/bin/env node

import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const CONFORMANCE_MODEL = "llama-swap/Qwen3.6-35B-A3B";
const MAX_REQUEST_BYTES = 64 * 1024;
const STREAM_CHUNKS = ["Deterministic ", "streamed ", "response."];
let toolCallSequence = 0;

async function requestJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, value) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(value));
}

function userText(messages) {
  const content = messages?.findLast((message) => message?.role === "user")?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function streamChunk(response, content, finishReason = null) {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-celld-conformance",
    object: "chat.completion.chunk",
    created: 0,
    model: CONFORMANCE_MODEL,
    choices: [{
      index: 0,
      delta: content === null ? {} : { content },
      finish_reason: finishReason,
    }],
  })}\n\n`);
}

function streamToolCall(response, name, input) {
  response.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-celld-conformance-tool",
    object: "chat.completion.chunk",
    created: 0,
    model: CONFORMANCE_MODEL,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: `call-${name}-${++toolCallSequence}`,
          type: "function",
          function: { name, arguments: JSON.stringify(input) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`);
  streamChunk(response, null, "tool_calls");
  response.end("data: [DONE]\n\n");
}

async function streamCompletion(response) {
  response.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
  });
  for (const chunk of STREAM_CHUNKS) {
    streamChunk(response, chunk);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
  }
  streamChunk(response, null, "stop");
  response.end("data: [DONE]\n\n");
}

async function handle(request, response) {
  const url = new URL(request.url ?? "/", "http://provider.invalid");
  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, 200, { ok: true, model: CONFORMANCE_MODEL });
  }
  if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    return json(response, 404, { error: { code: "not_found" } });
  }

  let body;
  try {
    body = await requestJson(request);
  } catch {
    return json(response, 400, { error: { code: "invalid_request" } });
  }
  if (body?.model !== CONFORMANCE_MODEL || body?.stream !== true ||
      !Array.isArray(body.messages) || body.messages.length === 0) {
    return json(response, 400, { error: { code: "invalid_request" } });
  }

  const prompt = userText(body.messages);
  if (prompt.includes("[provider-rejected]")) {
    return json(response, 429, { error: { code: "rate_limited" } });
  }
  if (prompt.includes("[provider-invalid-output]")) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    return response.end("data: not-json\n\ndata: [DONE]\n\n");
  }
  if (prompt.includes("[provider-unavailable]")) {
    request.socket.destroy();
    return;
  }
  if (body.messages.at(-1)?.role === "tool") {
    return streamCompletion(response);
  }
  if (prompt.includes("[tool-empty]")) {
    return streamToolCall(response, "rememberFact", { fact: "" });
  }
  if (prompt.includes("[tool-malformed]")) {
    return streamToolCall(response, "rememberFact", { fact: "malformed", agent: "beta" });
  }
  if (prompt.includes("[tool-remember]")) {
    const fact = prompt.split("[tool-remember]", 2)[1]?.trim() ?? "";
    return streamToolCall(response, "rememberFact", { fact });
  }
  if (prompt.includes("[tool-list]")) {
    return streamToolCall(response, "listMemories", {});
  }
  if (prompt.includes("[tool-summarize]")) {
    return streamToolCall(response, "summarizeMemories", {});
  }
  return streamCompletion(response);
}

/**
 * Creates the deterministic OpenAI-compatible streaming provider.
 *
 * @returns {import("node:http").Server} The unbound HTTP server.
 */
export function createDeterministicProvider() {
  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) {
        json(response, 500, { error: { code: "provider_internal_error" } });
      } else {
        response.destroy();
      }
    });
  });
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const host = option("--host", DEFAULT_HOST);
  const port = Number(option("--port", DEFAULT_PORT));
  const server = createDeterministicProvider();
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`deterministic model provider listening on http://${address.address}:${address.port}`);
  });
}
