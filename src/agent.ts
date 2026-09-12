/**
 * The ACP agent side of the bridge.
 *
 * Speaks ACP (protocol version 1, schema v0.11.3) to T3 Code on one side and
 * drives a pi `AgentSession` on the other.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  VERSION as PI_VERSION,
} from "@earendil-works/pi-coding-agent";

import { buildEffortConfigOption, EFFORT_CONFIG_ID, DEFAULT_EFFORT, normalizeEffort } from "./effort.ts";
import { allowlistedExtensionPaths } from "./extensions.ts";
import { StdioConnection } from "./jsonrpc.ts";
import { recall, remember } from "./sessionStore.ts";
import { resultContent, toolKind, toolLocations, toolTitle } from "./mapping.ts";

const PROTOCOL_VERSION = 1;

/**
 * T3 authenticates the Cursor driver with this method id
 * (`CursorAcpSupport.ts`: `authMethodId: "cursor_login"`). It must appear in
 * the `initialize` response or the handshake fails before `session/new`.
 */
const AUTH_METHOD_ID = "cursor_login";

export interface AgentOptions {
  /** Working directory T3 launched us in; pi resolves project context from it. */
  cwd: string;
  /** Skip per-tool approval round-trips (T3 runtime modes auto / full-access). */
  autoApprove: boolean;
}

interface ActiveSession {
  id: string;
  piSession: any;
  unsubscribe: () => void;
}

export function runAgent(options: AgentOptions): void {
  const connection = new StdioConnection();
  let modelRuntime: ModelRuntime | null = null;
  let registry: ModelRegistry | null = null;
  let session: ActiveSession | null = null;
  let requestedModel: string | null = null;
  let requestedEffort: string = DEFAULT_EFFORT;

  const getRegistry = async (): Promise<ModelRegistry> => {
    if (!registry) {
      modelRuntime ??= await ModelRuntime.create();
      registry = new ModelRegistry(modelRuntime);
    }
    return registry;
  };

  const update = (sessionId: string, payload: Record<string, unknown>): void => {
    connection.notify("session/update", { sessionId, update: payload });
  };

  // ── Handshake ────────────────────────────────────────────────────────

  connection.on("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
    },
    authMethods: [
      { id: AUTH_METHOD_ID, name: "pi", description: "pi uses its own provider credentials" },
    ],
    _meta: { bridge: "pi-t3-bridge", piVersion: PI_VERSION },
  }));

  // pi authenticates against its own providers via ~/.pi/agent/auth.json, so
  // there is nothing to do here beyond acknowledging the method.
  connection.on("authenticate", () => ({}));

  // ── Sessions ─────────────────────────────────────────────────────────

  /**
   * Build a pi session and adopt it as the active one. `sessionManager`
   * decides whether this is a fresh session or a resumed one; everything else
   * — the approval hook, event forwarding, effort — is identical either way.
   */
  async function openSession(id: string, cwd: string, sessionManager: any): Promise<void> {
    modelRuntime ??= await ModelRuntime.create();
    const approvals = new ApprovalBroker(id, connection, options.autoApprove);

    // Discovered extensions are deliberately disabled. pi's extension
    // ecosystem is written for the interactive TUI — several of them (the
    // tps-meter, for one) reach for the theme singleton the moment a turn
    // starts and throw outside interactive mode, which would take the bridge
    // process down mid-turn. The approval hook is supplied inline instead, so
    // it is the only extension running.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      additionalExtensionPaths: allowlistedExtensionPaths(),
      extensionFactories: [
        { name: "t3-approvals", factory: (pi: any) => approvals.register(pi) },
      ],
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd,
      modelRuntime,
      resourceLoader,
      sessionManager,
      ...(requestedModel ? { model: await resolveModel(requestedModel) } : {}),
    });

    created.session.setThinkingLevel(requestedEffort as any);

    const unsubscribe = created.session.subscribe((event: any) =>
      forwardPiEvent(id, event, update),
    );

    session?.unsubscribe();
    session = { id, piSession: created.session, unsubscribe };

    const sessionFile = sessionManager.getSessionFile?.();
    if (sessionFile) remember(id, sessionFile, cwd);
  }

  connection.on("session/new", async (params: any) => {
    const cwd: string = params?.cwd ?? options.cwd;
    const id = `pi-${Date.now().toString(36)}`;
    await openSession(id, cwd, SessionManager.create(cwd));
    return {
      sessionId: id,
      modes: null,
      configOptions: [buildEffortConfigOption(activeEffort())],
    };
  });

  /**
   * T3 calls this whenever a thread resumes, so refusing it breaks every
   * reopened thread with "Method not found: session/load".
   *
   * The session id is one the bridge issued earlier, in an earlier process, so
   * it is resolved through the on-disk store. When that lookup misses — a
   * store wiped, or a thread predating it — falling back to the most recent pi
   * session in the same directory is a better answer than an empty one.
   */
  connection.on("session/load", async (params: any) => {
    const cwd: string = params?.cwd ?? options.cwd;
    const id: string = params?.sessionId;
    const known = recall(id);

    const sessionManager = known?.sessionFile
      ? SessionManager.open(known.sessionFile, undefined, cwd)
      : SessionManager.continueRecent(cwd);

    await openSession(id, cwd, sessionManager);
    return {
      modes: null,
      configOptions: [buildEffortConfigOption(activeEffort())],
    };
  });

  connection.on("session/prompt", async (params: any) => {
    const active = requireSession(session, params?.sessionId);
    const text = extractPromptText(params?.prompt);
    const images = extractPromptImages(params?.prompt);

    const settled = new Promise<void>((resolve) => {
      const off = active.piSession.subscribe((event: any) => {
        if (event.type === "agent_settled") {
          off();
          resolve();
        }
      });
    });

    await active.piSession.prompt(text, images.length > 0 ? { images } : undefined);
    await settled;

    return { stopReason: "end_turn" };
  });

  connection.on("session/cancel", async () => {
    await session?.piSession.abort();
  });

  connection.on("session/close", () => {
    session?.unsubscribe();
    session = null;
    return {};
  });

  // ── Model selection ──────────────────────────────────────────────────

  connection.on("session/set_model", async (params: any) => {
    const slug: string | undefined = params?.modelId ?? params?.model;
    if (!slug) return {};
    requestedModel = slug;
    const model = await resolveModel(slug);
    if (model && session) await session.piSession.setModel(model);
    return {};
  });

  connection.on("session/set_config_option", (params: any) => {
    if (params?.configId === EFFORT_CONFIG_ID) {
      const level = normalizeEffort(params?.value);
      if (level) {
        requestedEffort = level;
        session?.piSession.setThinkingLevel(level);
      }
    }
    return { configOptions: [buildEffortConfigOption(activeEffort())] };
  });

  /**
   * The level pi actually settled on, which is not always the one asked for:
   * pi clamps to what the active model supports, so requesting "xhigh" on a
   * model that only does low/high/max lands on "max". Reporting the clamped
   * value back keeps T3's dropdown honest about what is really running.
   */
  function activeEffort(): string {
    const actual = session?.piSession?.thinkingLevel;
    return normalizeEffort(actual) ?? requestedEffort;
  }

  /**
   * Cursor-proprietary ACP extension that T3 calls during the status probe
   * (`CursorProvider.ts`: `acp.request("cursor/list_available_models", {})`).
   * Failing it is survivable — T3 degrades to a warning and falls back to the
   * instance's `customModels` — but answering it means the model picker lists
   * pi's real catalog.
   */
  connection.on("cursor/list_available_models", async () => {
    const available = (await getRegistry()).getAvailable();
    return {
      models: available.map((model) => ({
        value: `${model.provider}/${model.id}`,
        name: `${model.name} (${model.provider})`,
        // Only reasoning models get the dropdown; for the rest T3 correctly
        // shows no effort control at all.
        configOptions: model.reasoning ? [buildEffortConfigOption()] : [],
      })),
    };
  });

  async function resolveModel(slug: string): Promise<any> {
    const separator = slug.indexOf("/");
    if (separator === -1) return undefined;
    const provider = slug.slice(0, separator);
    const modelId = slug.slice(separator + 1);
    return (await getRegistry()).find(provider, modelId);
  }
}

function requireSession(session: ActiveSession | null, sessionId: unknown): ActiveSession {
  if (!session || (typeof sessionId === "string" && sessionId !== session.id)) {
    throw new Error(`Unknown session: ${String(sessionId)}`);
  }
  return session;
}

/** ACP delivers a prompt as content blocks; pi takes a string plus images. */
function extractPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return typeof prompt === "string" ? prompt : "";
  return prompt
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

function extractPromptImages(prompt: unknown): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(prompt)) return [];
  return prompt
    .filter((block: any) => block?.type === "image" && typeof block.data === "string")
    .map((block: any) => ({ data: block.data, mimeType: block.mimeType ?? "image/png" }));
}

/**
 * Map pi's session events onto ACP `session/update` notifications. T3 renders
 * `agent_message_chunk`, `agent_thought_chunk`, `tool_call` and
 * `tool_call_update`; anything else is ignored by the client, so unmapped pi
 * events are simply dropped rather than guessed at.
 */
function forwardPiEvent(
  sessionId: string,
  event: any,
  update: (sessionId: string, payload: Record<string, unknown>) => void,
): void {
  switch (event.type) {
    case "message_update": {
      const inner = event.assistantMessageEvent;
      if (inner?.type === "text_delta" && typeof inner.delta === "string") {
        update(sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: inner.delta },
        });
      } else if (inner?.type === "thinking_delta" && typeof inner.delta === "string") {
        update(sessionId, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: inner.delta },
        });
      }
      return;
    }
    case "tool_execution_start":
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: event.toolCallId,
        title: toolTitle(event.toolName, event.args),
        kind: toolKind(event.toolName),
        status: "in_progress",
        locations: toolLocations(event.args),
        rawInput: event.args,
      });
      return;
    case "tool_execution_end":
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: event.toolCallId,
        status: event.isError ? "failed" : "completed",
        content: resultContent(event.result),
      });
      return;
    default:
      return;
  }
}

/**
 * Routes pi's tool calls through ACP `session/request_permission` so approvals
 * render as real T3 approval cards instead of being auto-granted.
 *
 * pi awaits the `tool_call` extension event before running a tool, and a
 * handler returning `{ block: true }` refuses it — which is exactly the shape
 * ACP's permission flow needs.
 */
class ApprovalBroker {
  #allowedTools = new Set<string>();

  constructor(
    private readonly sessionId: string,
    private readonly connection: StdioConnection,
    private readonly autoApprove: boolean,
  ) {}

  register(pi: any): void {
    if (this.autoApprove) return;
    pi.on("tool_call", (event: any) => this.#ask(event));
  }

  async #ask(event: any): Promise<Record<string, unknown>> {
    if (this.#allowedTools.has(event.toolName)) return {};

    const args = event.input ?? event.args;
    let response: any;
    try {
      response = await this.connection.request("session/request_permission", {
        sessionId: this.sessionId,
        toolCall: {
          toolCallId: event.toolCallId ?? `${event.toolName}-${Date.now()}`,
          title: toolTitle(event.toolName, args),
          kind: toolKind(event.toolName),
          status: "pending",
          locations: toolLocations(args),
          rawInput: args,
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow for this session", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
    } catch (error) {
      // A client that cannot answer must not silently become a client that
      // approves everything.
      return { block: true, reason: `Approval request failed: ${String(error)}` };
    }

    const outcome = response?.outcome;
    if (outcome?.outcome === "cancelled") {
      return { block: true, reason: "Cancelled by the user." };
    }

    switch (outcome?.optionId) {
      case "allow-always":
        this.#allowedTools.add(event.toolName);
        return {};
      case "allow-once":
        return {};
      default:
        return { block: true, reason: "Denied by the user in T3 Code." };
    }
  }
}
