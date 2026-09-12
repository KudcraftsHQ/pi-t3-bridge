/**
 * End-to-end smoke test: drives the bridge the way T3 Code does.
 *
 * Usage: bun scripts/smoke.ts <cwd> <model-slug> "<prompt>"
 */
import { spawn } from "node:child_process";

const [cwd = process.cwd(), model = "", promptText = "Say the word: pong"] = process.argv.slice(2);

const child = spawn("./bin/pi-t3-bridge", ["acp"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env },
});

let nextId = 1;
const pending = new Map<number, (value: any) => void>();
let buffer = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  buffer += chunk;
  let newline: number;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const raw = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!raw.trim()) continue;
    const message = JSON.parse(raw);

    if (message.method === "session/update") {
      const update = message.params.update;
      if (update.sessionUpdate === "agent_message_chunk") process.stdout.write(update.content.text);
      else if (update.sessionUpdate === "agent_thought_chunk") process.stderr.write(".");
      else if (update.sessionUpdate === "tool_call")
        console.log(`\n  [tool] ${update.kind}: ${update.title}`);
      else if (update.sessionUpdate === "tool_call_update")
        console.log(`  [tool] -> ${update.status}`);
      continue;
    }

    if (message.method === "session/request_permission") {
      console.log(`\n  [permission asked] ${message.params.toolCall.title} -> ${process.env.SMOKE_DENY ? "rejecting" : "allowing once"}`);
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { outcome: { outcome: "selected", optionId: process.env.SMOKE_DENY ? "reject-once" : "allow-once" } },
        })}\n`,
      );
      continue;
    }

    if (message.id !== undefined) {
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message.error ? Promise.reject(new Error(message.error.message)) : message.result);
      }
    }
  }
});

function call(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const init = await call("initialize", {
  protocolVersion: 1,
  clientCapabilities: { _meta: { parameterizedModelPicker: true } },
});
console.log(`initialize ok — pi ${init._meta.piVersion}`);

await call("authenticate", { methodId: "cursor_login" });
if (model) await call("session/set_model", { modelId: model });

const session = await call("session/new", { cwd, mcpServers: [] });
console.log(`session ${session.sessionId} in ${cwd}\n`);

const result = await call("session/prompt", {
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: promptText }],
});
console.log(`\n\nstopReason: ${result.stopReason}`);
child.kill();
