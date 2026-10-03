/**
 * MCP passthrough: what T3 Code's Orchestrator V2 puts in `session/new`
 * (`AcpAdapterV2.ts` acpMcpContext) must come out as callable pi tools.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  connectMcpServers,
  mcpResultContent,
  mcpToolDefinitions,
  mcpToolName,
  t3FallbackEnvironment,
  usableMcpServers,
} from "../src/mcp.ts";
import { buildModelConfigOption } from "../src/agent.ts";

const fake = {
  name: "t3-code",
  command: process.execPath,
  args: [join(import.meta.dir, "fixtures", "fake-mcp-server.mjs")],
  env: [{ name: "FAKE_ENV", value: "ok" }],
};

describe("MCP passthrough", () => {
  test("stdio server tools become namespaced pi tools that call through", async () => {
    const [connection] = await connectMcpServers([fake], process.cwd());
    try {
      expect(connection!.tools.map((t) => t.name)).toEqual(["echo", "fail"]);
      const tools = mcpToolDefinitions([connection!]);
      expect(tools.map((t) => t.name)).toEqual(["mcp__t3-code__echo", "mcp__t3-code__fail"]);
      const result = await tools[0].execute("1", { text: "hi" });
      expect(result.content).toEqual([{ type: "text", text: "echo:hi:ok" }]);
      await expect(tools[1].execute("2", {})).rejects.toThrow("boom");
    } finally {
      connection?.close();
    }
  });

  test("a server that cannot start is skipped, not fatal", async () => {
    const connected = await connectMcpServers(
      [{ name: "missing", command: "/nonexistent/binary" }],
      process.cwd(),
    );
    expect(connected).toEqual([]);
  });

  test("only servable declarations are accepted", () => {
    expect(
      usableMcpServers([
        fake,
        { type: "acp", name: "t3-code", serverId: "t3-code" },
        { type: "http", name: "h", url: "http://x", headers: [] },
        { name: "" },
      ]).map((s) => s.name),
    ).toEqual(["t3-code", "h"]);
  });

  test("tool names follow T3's mcp__<server>__<tool> convention", () => {
    expect(mcpToolName("t3-code", "delegate_task")).toBe("mcp__t3-code__delegate_task");
    expect(mcpToolName("a b", "c.d")).toBe("mcp__a_b__c_d");
  });

  test("oversized results are cut inline and spilled to a file in full", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pi-t3-bridge-test-"));
    process.env.PI_T3_BRIDGE_MCP_MAX_CHARS = "10";
    process.env.PI_T3_BRIDGE_SPILL_DIR = dir;
    try {
      const full = "x".repeat(50);
      const [block] = mcpResultContent({ content: [{ type: "text", text: full }] }, "t3-code-caps");
      const text = (block as { text: string }).text;
      expect(text).toContain("[truncated by pi-t3-bridge: 50 chars");
      const file = /in (\S+) — read/.exec(text)?.[1];
      expect(file && readFileSync(file, "utf8")).toBe(full);
    } finally {
      delete process.env.PI_T3_BRIDGE_MCP_MAX_CHARS;
      delete process.env.PI_T3_BRIDGE_SPILL_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fallback env is recovered from T3's injected stdio server", () => {
    const env = t3FallbackEnvironment([
      {
        name: "t3-code",
        command: "/opt/t3/t3",
        args: ["/opt/t3/server.js", "acp-mcp-bridge"],
        env: [
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
          { name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:1/mcp" },
          { name: "T3_ACP_MCP_AUTHORIZATION", value: "Bearer x" },
        ],
      },
    ]);
    expect(env).toEqual({
      T3_ACP_MCP_NODE: "/opt/t3/t3",
      T3_ACP_MCP_ENTRYPOINT: "/opt/t3/server.js",
      T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:1/mcp",
      T3_ACP_MCP_AUTHORIZATION: "Bearer x",
    });
    expect(
      t3FallbackEnvironment([{ name: "t3-code", command: "/opt/t3/t3", args: ["acp-mcp-bridge"] }]),
    ).toEqual({ T3_ACP_MCP_NODE: "/opt/t3/t3" });
  });
});

describe("model config option (generic ACP driver)", () => {
  test("is a category:model select with provider-qualified values", () => {
    const option = buildModelConfigOption(
      [
        { provider: "deepseek", id: "deepseek-v4-flash", name: "Flash" },
        { provider: "deepseek", id: "deepseek-v4-pro", name: "Pro" },
      ],
      "deepseek/deepseek-v4-pro",
    );
    expect(option).toMatchObject({ id: "model", category: "model", type: "select", currentValue: "deepseek/deepseek-v4-pro" });
    expect(option.options[0]).toEqual({ value: "deepseek/deepseek-v4-flash", name: "Flash (deepseek)" });
  });
});
