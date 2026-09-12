/**
 * Newline-delimited JSON-RPC 2.0 over stdio.
 *
 * Framing is strict JSONL: records are split on LF only. A generic line
 * reader is deliberately not used here — Node's `readline` also splits on
 * U+2028/U+2029, which are legal inside JSON strings and would corrupt any
 * payload containing them.
 */
export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type MethodHandler = (params: any) => Promise<unknown> | unknown;

/** JSON-RPC error codes used by the bridge. */
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;

export class StdioConnection {
  #handlers = new Map<string, MethodHandler>();
  #pending = new Map<JsonRpcId, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #buffer = "";
  #out: NodeJS.WritableStream;

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ) {
    this.#out = output;
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string) => this.#onData(chunk));
  }

  on(method: string, handler: MethodHandler): void {
    this.#handlers.set(method, handler);
  }

  /** Fire-and-forget notification to the peer. */
  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  /** Request the peer and await its response. */
  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  #write(message: unknown): void {
    this.#out.write(`${JSON.stringify(message)}\n`);
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const raw = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (raw.trim().length === 0) continue;
      void this.#dispatch(raw);
    }
  }

  async #dispatch(raw: string): Promise<void> {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // A frame we cannot parse is not a frame we can answer.
    }

    // A response to something we asked the client.
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "RPC error"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const handler = this.#handlers.get(message.method);
    const isRequest = message.id !== undefined;

    if (!handler) {
      if (isRequest) {
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: RPC_METHOD_NOT_FOUND, message: `Method not found: ${message.method}` },
        });
      }
      return;
    }

    try {
      const result = await handler(message.params ?? {});
      if (isRequest) {
        this.#write({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
      }
    } catch (error) {
      if (isRequest) {
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: RPC_INTERNAL_ERROR,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }
}
