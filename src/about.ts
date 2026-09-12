/**
 * The `about` probe.
 *
 * T3 Code health-checks the Cursor driver by running `<binaryPath> about
 * --format json` and parsing the result (`CursorProvider.ts`,
 * `checkCursorProviderStatus`). The bridge answers that probe so the
 * provider instance reports as ready.
 *
 * Three things in the response are load-bearing:
 *
 *  - `cliVersion` must match /^\d{4}\.\d{2}\.\d{2}/ and parse to a date at
 *    or after CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE (currently
 *    2026-04-08). A lower version is rejected with "too old for Cursor ACP
 *    parameterized model picker".
 *  - `userEmail` must be a non-empty string that does not look like a
 *    logged-out marker ("not logged in", "login required", …), or T3 reports
 *    the provider as unauthenticated.
 *  - The whole thing must be on stdout within 8s (ABOUT_TIMEOUT_MS).
 */
export const COMPAT_CLI_VERSION = process.env.PI_T3_BRIDGE_CLI_VERSION ?? "2026.09.12";
export const ACCOUNT_LABEL = process.env.PI_T3_BRIDGE_ACCOUNT ?? "pi@local";

export interface AboutPayload {
  cliVersion: string;
  userEmail: string;
  subscriptionTier: string;
}

export function buildAboutPayload(piVersion: string): AboutPayload {
  return {
    cliVersion: `${COMPAT_CLI_VERSION}-pi${piVersion}`,
    userEmail: ACCOUNT_LABEL,
    subscriptionTier: "pi",
  };
}

/**
 * Key-value rendering, used when T3 falls back to a bare `about` because the
 * CLI it is talking to did not understand `--format json`. T3 parses these
 * with /^<key>\s{2,}(.+)$/m, so the column gap must be at least two spaces.
 */
export function renderAboutText(payload: AboutPayload): string {
  return [
    "About Cursor CLI",
    "",
    `CLI Version         ${payload.cliVersion}`,
    `User Email          ${payload.userEmail}`,
    `Subscription        ${payload.subscriptionTier}`,
    "",
  ].join("\n");
}
