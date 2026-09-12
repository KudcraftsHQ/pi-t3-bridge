/**
 * Translation between pi's tool vocabulary and ACP's.
 *
 * ACP tool kinds drive which icon and affordance T3 renders for a tool call
 * (see `AcpRuntimeModel.ts` / `AcpCoreRuntimeEvents.ts`), so getting these
 * right is the difference between a labelled diff card and an anonymous box.
 */
export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "fetch"
  | "think"
  | "other";

const TOOL_KIND_BY_NAME: Record<string, AcpToolKind> = {
  read: "read",
  ls: "read",
  bash: "execute",
  powershell: "execute",
  edit: "edit",
  write: "edit",
  grep: "search",
  find: "search",
};

export function toolKind(toolName: string): AcpToolKind {
  return TOOL_KIND_BY_NAME[toolName] ?? "other";
}

/** Best-effort one-line title for a tool call, from its arguments. */
export function toolTitle(toolName: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  };

  switch (toolName) {
    case "bash":
    case "powershell":
      return pick("command") ?? toolName;
    case "read":
    case "write":
    case "edit":
      return `${toolName} ${pick("path") ?? pick("file_path") ?? ""}`.trim();
    case "grep":
      return `grep ${pick("pattern") ?? ""}`.trim();
    case "find":
      return `find ${pick("pattern") ?? pick("path") ?? ""}`.trim();
    case "ls":
      return `ls ${pick("path") ?? ""}`.trim();
    default:
      return toolName;
  }
}

/**
 * Locations let T3 anchor a tool call to a file, which is what turns an edit
 * into a reviewable diff rather than a log line.
 */
export function toolLocations(args: unknown): Array<{ path: string }> {
  const record = (args ?? {}) as Record<string, unknown>;
  const candidate = record["path"] ?? record["file_path"];
  return typeof candidate === "string" && candidate.length > 0 ? [{ path: candidate }] : [];
}

/** Flatten an arbitrary pi tool result into ACP text content blocks. */
export function resultContent(result: unknown): Array<{ type: "content"; content: unknown }> {
  if (result === undefined || result === null) return [];
  const text =
    typeof result === "string"
      ? result
      : (() => {
          try {
            return JSON.stringify(result, null, 2);
          } catch {
            return String(result);
          }
        })();
  if (text.trim().length === 0) return [];
  return [{ type: "content", content: { type: "text", text } }];
}
