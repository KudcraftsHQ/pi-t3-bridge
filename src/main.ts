/**
 * pi-t3-bridge — run the pi coding agent as a native provider inside T3 Code.
 *
 * T3 has no pi driver (`piAgent` is still a "coming soon" chip in the Add
 * Provider dialog), but its Cursor driver spawns an arbitrary binary and
 * speaks standard ACP to it. This binary impersonates the Cursor Agent CLI
 * closely enough to pass T3's health probe, then serves pi over ACP.
 *
 * Argv modes:
 *   about [--format json]   health probe
 *   acp                     ACP agent over stdio
 *
 * T3 may prepend flags before `acp` (`-e <endpoint>` when apiEndpoint is set,
 * and `--auto-review` / `--force` depending on the thread's runtime mode), so
 * argv is scanned rather than matched positionally.
 */
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";

import { buildAboutPayload, renderAboutText } from "./about.ts";
import { runAgent } from "./agent.ts";

function main(): void {
  const argv = process.argv.slice(2);

  if (argv.includes("about")) {
    const payload = buildAboutPayload(PI_VERSION);
    const wantsJson = argv.includes("--format") && argv.includes("json");
    process.stdout.write(wantsJson ? `${JSON.stringify(payload)}\n` : renderAboutText(payload));
    process.exit(0);
  }

  if (argv.includes("acp")) {
    // In ACP mode stdout is the protocol channel. Anything pi or its
    // dependencies print would corrupt the frame stream, so console output is
    // diverted to stderr for the lifetime of the process.
    console.log = console.info = console.warn = console.debug = (...args: unknown[]) => {
      process.stderr.write(`${args.map(String).join(" ")}\n`);
    };

    runAgent({
      cwd: process.cwd(),
      // T3 passes these when the thread runs in auto / full-access mode, which
      // is its way of saying "stop asking me about every tool call".
      autoApprove: argv.includes("--force") || argv.includes("--auto-review"),
    });
    return;
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${buildAboutPayload(PI_VERSION).cliVersion}\n`);
    process.exit(0);
  }

  process.stderr.write(
    [
      "pi-t3-bridge — ACP bridge exposing pi as a T3 Code provider",
      "",
      "Usage:",
      "  pi-t3-bridge about [--format json]   Health probe (T3 calls this)",
      "  pi-t3-bridge acp                     Serve ACP over stdio",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

main();
