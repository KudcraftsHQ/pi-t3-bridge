/**
 * These tests encode T3 Code's side of the contract. They are copies of the
 * checks in `apps/server/src/provider/Layers/CursorProvider.ts`; if T3 tightens
 * a gate, the corresponding test here is what should be updated first.
 */
import { describe, expect, test } from "bun:test";

import { buildAboutPayload, renderAboutText } from "../src/about.ts";
import { toolKind, toolTitle } from "../src/mapping.ts";
import { StdioConnection } from "../src/jsonrpc.ts";
import { PassThrough } from "node:stream";

/** CursorProvider.ts: CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE */
const MIN_VERSION_DATE = 2026_04_08;

/** CursorProvider.ts: parseCursorVersionDate */
function parseCursorVersionDate(version: string): number | undefined {
  const match = version.trim().match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\b|-|$)/);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return Number(`${year}${month}${day}`);
}

/** CursorProvider.ts: extractAboutField */
function extractAboutField(plain: string, key: string): string | undefined {
  return new RegExp(`^${key}\\s{2,}(.+)$`, "mi").exec(plain)?.[1]?.trim();
}

describe("about probe", () => {
  const payload = buildAboutPayload("0.85.1");

  test("reports a version T3 parses as a date", () => {
    expect(parseCursorVersionDate(payload.cliVersion)).toBeDefined();
  });

  test("clears the parameterized model picker version floor", () => {
    expect(parseCursorVersionDate(payload.cliVersion)!).toBeGreaterThanOrEqual(MIN_VERSION_DATE);
  });

  test("reports an account that does not read as logged out", () => {
    const lower = payload.userEmail.toLowerCase();
    expect(payload.userEmail.length).toBeGreaterThan(0);
    expect(lower).not.toBe("not logged in");
    expect(lower).not.toContain("login required");
    expect(lower).not.toContain("authentication required");
  });

  test("key-value fallback is parseable by T3's field extractor", () => {
    const text = renderAboutText(payload);
    expect(extractAboutField(text, "CLI Version")).toBe(payload.cliVersion);
    expect(extractAboutField(text, "User Email")).toBe(payload.userEmail);
  });
});

describe("tool mapping", () => {
  test("maps pi tools onto ACP kinds T3 renders", () => {
    expect(toolKind("bash")).toBe("execute");
    expect(toolKind("read")).toBe("read");
    expect(toolKind("write")).toBe("edit");
    expect(toolKind("grep")).toBe("search");
    expect(toolKind("something-else")).toBe("other");
  });

  test("titles a bash call with its command", () => {
    expect(toolTitle("bash", { command: "echo hi" })).toBe("echo hi");
  });

  test("falls back to the tool name when arguments are unusable", () => {
    expect(toolTitle("bash", {})).toBe("bash");
  });
});

describe("jsonrpc framing", () => {
  test("splits records on LF only, not on U+2028", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const connection = new StdioConnection(input, output);

    const seen: string[] = [];
    connection.on("echo", (params: any) => {
      seen.push(params.text);
      return {};
    });

    // U+2028 inside a JSON string is legal and must not end the record.
    input.write(`{"jsonrpc":"2.0","id":1,"method":"echo","params":{"text":"a\\u2028b"}}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(seen).toEqual(["a\u2028b"]);
  });
});
