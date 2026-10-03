/**
 * MCP passthrough: the servers T3 Code puts in `session/new` / `session/load`
 * become pi tools.
 *
 * Under T3's Orchestrator V2 every ACP session is handed a `t3-code` MCP
 * server — thread launch/read/wait, delegate_task, task_status, worktrees,
 * previews, scheduled tasks. T3 sends it as a stdio server (`t3
 * acp-mcp-bridge`, credentials in its env) because stdio is ACP's baseline
 * transport. pi has no MCP client of its own, so the bridge is one: it spawns
 * each declared server, lists its tools, and registers every tool with pi as
 * `mcp__<server>__<tool>` through an inline extension. Tool calls then flow
 * through pi's normal tool pipeline — including the T3 approval hook.
 *
 * Only what T3 needs is implemented: stdio and streamable-HTTP transports,
 * `initialize`, `tools/list` (paginated) and `tools/call`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AcpEnvEntry {
  name: string;
  value: string;
}

/** ACP `McpServer`: stdio has no `type`; http/sse carry `type` and `url`. */
export interface AcpMcpServer {
  name: string;
  type?: string;
  command?: string;
  args?: string[];
  env?: AcpEnvEntry[];
  url?: string;
  headers?: AcpEnvEntry[];
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string };
}

interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CONNECT_TIMEOUT_MS = 20_000;

function dbg(message: string): void {
  if (process.env.PI_T3_BRIDGE_DEBUG) process.stderr.write(`[mcp] ${message}\n`);
}

function envRecord(entries: AcpEnvEntry[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries ?? []) {
    if (entry && typeof entry.name === "string") out[entry.name] = String(entry.value ?? "");
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface Transport {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<any>;
  notify(method: string, params: unknown): Promise<void> | void;
  close(): void;
}

/** Newline-delimited JSON-RPC to a spawned MCP server. */
class StdioTransport implements Transport {
  #child: ChildProcess;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #closed = false;

  constructor(server: AcpMcpServer, cwd: string) {
    this.#child = spawn(server.command!, server.args ?? [], {
      cwd,
      env: { ...process.env, ...envRecord(server.env) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout!.setEncoding("utf8");
    this.#child.stdout!.on("data", (chunk: string) => this.#onData(chunk));
    // A server's stderr is diagnostics; never let it reach our ACP stdout.
    this.#child.stderr!.on("data", (chunk) => dbg(`${server.name} stderr: ${String(chunk).trim()}`));
    this.#child.on("error", (error) => this.#failAll(error));
    this.#child.on("exit", (code) => this.#failAll(new Error(`MCP server exited (code ${code})`)));
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message?.id === "number" && this.#pending.has(message.id) && !message.method) {
        const waiter = this.#pending.get(message.id)!;
        this.#pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "MCP error"));
        else waiter.resolve(message.result);
      } else if (message?.method && message.id !== undefined) {
        // Server-initiated requests (sampling, roots, elicitation) are not
        // supported; answer so the server does not hang waiting.
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        });
      }
    }
  }

  #write(message: unknown): void {
    if (this.#closed || !this.#child.stdin?.writable) return;
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const waiter of this.#pending.values()) waiter.reject(error);
    this.#pending.clear();
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (this.#closed) return Promise.reject(new Error("MCP server is not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.#pending.has(id)) return;
          this.#pending.delete(id);
          this.notify("notifications/cancelled", { requestId: id, reason: "aborted" });
          reject(new Error("Aborted"));
        },
        { once: true },
      );
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.#closed = true;
    try {
      this.#child.stdin?.end();
      this.#child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
}

/** Streamable-HTTP MCP (JSON or SSE responses), with session id replay. */
class HttpTransport implements Transport {
  #sessionId: string | undefined;
  #protocolVersion: string | undefined;
  #nextId = 1;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
  ) {}

  async #post(body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(this.url, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...this.headers,
        ...(this.#sessionId ? { "mcp-session-id": this.#sessionId } : {}),
        ...(this.#protocolVersion ? { "mcp-protocol-version": this.#protocolVersion } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    const id = this.#nextId++;
    const response = await this.#post({ jsonrpc: "2.0", id, method, params }, signal);
    const session = response.headers.get("mcp-session-id");
    if (session) this.#sessionId = session;
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
    const type = response.headers.get("content-type") ?? "";
    const messages: any[] = [];
    if (type.includes("text/event-stream")) {
      const text = await response.text();
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) {
          try {
            messages.push(JSON.parse(data));
          } catch {
            // ignore keepalives
          }
        }
      }
    } else {
      messages.push(await response.json());
    }
    const reply = messages.find((message) => message?.id === id);
    if (!reply) throw new Error(`MCP HTTP: no response for ${method}`);
    if (reply.error) throw new Error(reply.error.message ?? "MCP error");
    if (method === "initialize" && typeof reply.result?.protocolVersion === "string") {
      this.#protocolVersion = reply.result.protocolVersion;
    }
    return reply.result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.#post({ jsonrpc: "2.0", method, params }).catch(() => undefined);
  }

  close(): void {}
}

export class McpConnection {
  private constructor(
    readonly name: string,
    readonly tools: McpToolInfo[],
    private readonly transport: Transport,
  ) {}

  static async connect(server: AcpMcpServer, cwd: string): Promise<McpConnection> {
    const transport: Transport =
      server.type === "http" || server.type === "sse"
        ? new HttpTransport(server.url!, envRecord(server.headers))
        : new StdioTransport(server, cwd);
    try {
      await withTimeout(
        transport.request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "pi-t3-bridge", version: "0.2.0" },
        }),
        CONNECT_TIMEOUT_MS,
        `MCP ${server.name} initialize`,
      );
      await transport.notify("notifications/initialized", {});
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page: any = await withTimeout(
          transport.request("tools/list", cursor ? { cursor } : {}),
          CONNECT_TIMEOUT_MS,
          `MCP ${server.name} tools/list`,
        );
        for (const tool of page?.tools ?? []) {
          if (typeof tool?.name === "string") tools.push(tool);
        }
        cursor = typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      } while (cursor);
      return new McpConnection(server.name, tools, transport);
    } catch (error) {
      transport.close();
      throw error;
    }
  }

  call(tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    return this.transport.request("tools/call", { name: tool, arguments: args ?? {} }, signal);
  }

  close(): void {
    this.transport.close();
  }
}

/** Accepts only declarations the bridge can actually serve. */
export function usableMcpServers(value: unknown): AcpMcpServer[] {
  if (!Array.isArray(value)) return [];
  return value.filter((server: any): server is AcpMcpServer => {
    if (!server || typeof server.name !== "string" || !server.name.trim()) return false;
    if (server.type === "http" || server.type === "sse") return typeof server.url === "string";
    if (server.type === undefined || server.type === "stdio") return typeof server.command === "string";
    return false; // e.g. `{type:"acp"}` — not advertised, so never expected
  });
}

/** Connect every server; one that fails is reported and skipped. */
export async function connectMcpServers(
  servers: AcpMcpServer[],
  cwd: string,
): Promise<McpConnection[]> {
  const results = await Promise.allSettled(servers.map((server) => McpConnection.connect(server, cwd)));
  const connected: McpConnection[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      connected.push(result.value);
      dbg(`${result.value.name}: ${result.value.tools.length} tools`);
    } else {
      process.stderr.write(
        `pi-t3-bridge: MCP server ${servers[index]!.name} unavailable: ${String(result.reason)}\n`,
      );
    }
  });
  return connected;
}

function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `mcp__<server>__<tool>`, the convention T3's instructions already name. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`.slice(0, 64);
}

function maxResultChars(): number {
  const raw = Number(process.env.PI_T3_BRIDGE_MCP_MAX_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : 100_000;
}

/**
 * Where an oversized result is written in full. Never a bare `/tmp`: on the
 * host this runs on that is RAM-backed tmpfs.
 */
function spillDirectory(): string {
  const base =
    process.env.PI_T3_BRIDGE_SPILL_DIR?.trim() ||
    process.env.TMPDIR?.trim() ||
    join(homedir(), ".cache", "tmp");
  return join(base, "pi-t3-bridge-mcp");
}

function spill(label: string, text: string): string | undefined {
  try {
    const dir = spillDirectory();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${label.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now().toString(36)}.txt`);
    writeFileSync(file, text);
    return file;
  } catch {
    return undefined;
  }
}

/**
 * MCP content → pi tool content. Oversized text is cut to the inline limit and
 * the full text is written to a file the agent can read or grep, so nothing is
 * silently lost (T3's `orchestrator_capabilities` alone runs ~200K chars).
 */
export function mcpResultContent(result: McpCallResult, label = "mcp-result"): Array<
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
> {
  const out: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const block of result?.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text });
    } else if (block.type === "image" && typeof block.data === "string") {
      out.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
    } else if (block.type === "resource" && typeof block.resource?.text === "string") {
      out.push({ type: "text", text: block.resource.text });
    }
  }
  if (out.length === 0 && result?.structuredContent !== undefined) {
    out.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  }
  const limit = maxResultChars();
  for (const block of out) {
    if (block.type === "text" && block.text.length > limit) {
      const file = spill(label, block.text);
      block.text =
        `${block.text.slice(0, limit)}\n\n[truncated by pi-t3-bridge: ${block.text.length} chars, showing first ${limit}. ` +
        (file
          ? `The complete result is in ${file} — read or grep that file for the rest.]`
          : "The complete result could not be saved.]");
    }
  }
  return out.length > 0 ? out : [{ type: "text", text: "(no content)" }];
}

/** pi tool definitions for every connected tool. */
export function mcpToolDefinitions(connections: McpConnection[]): any[] {
  const seen = new Set<string>();
  const definitions: any[] = [];
  for (const connection of connections) {
    for (const tool of connection.tools) {
      const name = mcpToolName(connection.name, tool.name);
      if (seen.has(name)) continue;
      seen.add(name);
      definitions.push({
        name,
        label: `${connection.name}: ${tool.name}`,
        description: tool.description ?? `${tool.name} (MCP server ${connection.name})`,
        // pi-ai validates plain JSON Schema as well as TypeBox schemas.
        parameters:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? tool.inputSchema
            : { type: "object", properties: {} },
        async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
          const result = await connection.call(tool.name, params, signal);
          const content = mcpResultContent(result, `${connection.name}-${tool.name}`);
          if (result?.isError) {
            throw new Error(content.map((block) => (block.type === "text" ? block.text : "")).join("\n"));
          }
          return { content, details: { server: connection.name, tool: tool.name } };
        },
      });
    }
  }
  return definitions;
}

/**
 * T3's documented ACP fallback (`acp-mcp-call` through the terminal) reads
 * `T3_ACP_MCP_*` from the environment. T3 sets them only on terminals it
 * spawns for the agent, and pi runs its own shell, so the bridge recovers them
 * from the injected `t3-code` declaration and exports them to pi's tools.
 */
export function t3FallbackEnvironment(servers: AcpMcpServer[]): Record<string, string> {
  const t3 = servers.find(
    (server) => server.command && (server.args ?? []).includes("acp-mcp-bridge"),
  );
  if (!t3?.command) return {};
  const env = envRecord(t3.env);
  const args = t3.args ?? [];
  const bridgeIndex = args.indexOf("acp-mcp-bridge");
  const out: Record<string, string> = { T3_ACP_MCP_NODE: t3.command };
  if (bridgeIndex > 0) out.T3_ACP_MCP_ENTRYPOINT = args[bridgeIndex - 1]!;
  if (env.T3_ACP_MCP_ENDPOINT) out.T3_ACP_MCP_ENDPOINT = env.T3_ACP_MCP_ENDPOINT;
  if (env.T3_ACP_MCP_AUTHORIZATION) out.T3_ACP_MCP_AUTHORIZATION = env.T3_ACP_MCP_AUTHORIZATION;
  return out;
}
