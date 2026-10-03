// Minimal stdio MCP server for tests: one paginated tools/list and an echo tool.
let buffer = "";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    else if (msg.method === "tools/list" && !msg.params?.cursor) send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }], nextCursor: "p2" } });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "fail", inputSchema: { type: "object" } }] } });
    else if (msg.method === "tools/call" && msg.params.name === "echo") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo:${msg.params.arguments.text}:${process.env.FAKE_ENV ?? ""}` }] } });
    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "boom" }] } });
    else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  }
});
