/**
 * Maps ACP session ids onto pi session files.
 *
 * T3 resumes a thread by calling `session/load` with the session id the bridge
 * handed out earlier — possibly days later, and always in a *new* bridge
 * process, because T3 spawns the provider afresh per session runtime. An
 * in-memory map therefore cannot answer it; the association has to outlive the
 * process.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const STORE_PATH =
  process.env.PI_T3_BRIDGE_STATE ?? join(homedir(), ".pi", "t3-bridge-sessions.json");

/** Entries older than this are pruned; T3 will not resume a thread this stale. */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

interface Entry {
  sessionFile: string;
  cwd: string;
  updatedAt: number;
}

function read(): Record<string, Entry> {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Record<string, Entry>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function remember(sessionId: string, sessionFile: string, cwd: string): void {
  try {
    const store = read();
    store[sessionId] = { sessionFile, cwd, updatedAt: Date.now() };

    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [key, entry] of Object.entries(store)) {
      if (entry.updatedAt < cutoff) delete store[key];
    }

    mkdirSync(dirname(STORE_PATH), { recursive: true });
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch {
    // Losing the mapping degrades resumption to "continue the most recent
    // session in this directory". It must not fail the turn.
  }
}

export function recall(sessionId: string): Entry | undefined {
  return read()[sessionId];
}
