/**
 * Extension allowlist.
 *
 * Discovery stays off: pi's extension ecosystem is written for the interactive
 * TUI, and an extension that reaches for the theme singleton mid-turn (the
 * tps-meter does) throws outside it and takes the bridge process down.
 *
 * But some extensions are load-bearing for correctness rather than display —
 * `deepseek-peak` rewrites message usage to apply DeepSeek's 50% off-peak
 * discount, so without it every cost pi records is priced at peak. Those are
 * opted into explicitly by path:
 *
 *   PI_T3_BRIDGE_EXTENSIONS=deepseek-peak,some/other.ts
 *
 * A bare name resolves against pi's own extensions directory. Anything
 * containing a separator is treated as a path.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

const PI_EXTENSIONS_DIR = join(homedir(), ".pi", "agent", "extensions");

export function allowlistedExtensionPaths(): string[] {
  const raw = process.env.PI_T3_BRIDGE_EXTENSIONS?.trim();
  if (!raw) return [];

  const resolved: string[] = [];
  for (const entry of raw.split(",")) {
    const name = entry.trim();
    if (!name) continue;

    const candidates =
      name.includes("/") || isAbsolute(name)
        ? [resolve(name)]
        : [join(PI_EXTENSIONS_DIR, name), join(PI_EXTENSIONS_DIR, `${name}.ts`)];

    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) {
      resolved.push(found);
    } else {
      process.stderr.write(`pi-t3-bridge: allowlisted extension not found: ${name}\n`);
    }
  }
  return resolved;
}
