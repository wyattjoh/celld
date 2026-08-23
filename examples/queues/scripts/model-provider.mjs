import { createServer } from "node:http";

const host = process.argv[process.argv.indexOf("--host") + 1] || "127.0.0.1";
const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 8788);

createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"not_found"}');
}).listen(port, host, () => {
  console.log(`queue fixture health server listening on http://${host}:${port}`);
});
