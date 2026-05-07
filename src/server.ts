#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { allTools, callTool } from "./tools/index.js";

const VERSION = "0.1.0";

const INSTRUCTIONS = `
This MCP server wraps HarmonyOS dev CLIs (hdc, hvigorw, Emulator).

Recommended workflow:
  1. session_show_defaults — verify toolchain status and current session.
  2. emu_list, then emu_start "<name>" — launch a simulator. Sets deviceSn automatically.
  3. session_set_defaults — seed projectDir / bundleName / abilityName / module.
  4. build → install → launch loop.
  5. screenshot / ui_dump / tap / swipe / input_text to drive the UI.

Resolution order for tool args: explicit > session default > error with guidance.
Prefer these tools over raw shell — output is parsed into structured summaries.
`.trim();

async function main(): Promise<void> {
  const server = new Server(
    { name: "harmonyos-mcp", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return await callTool(req.params.name, req.params.arguments ?? {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[harmonyos-mcp] fatal:", err);
  process.exit(1);
});
