import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ok, ToolResult } from "../lib/result.js";
import { getDefaults, setDefaults, clearDefaults, Defaults } from "../lib/session.js";
import { probeToolchain } from "../lib/toolchain.js";

const ShowArgs = z.object({});

export const sessionShowTool = {
  name: "session_show_defaults",
  description:
    "Show current session defaults (project, module, bundle, ability, deviceSn, etc) and toolchain status. " +
    "Call this first when starting a new task.",
  inputSchema: zodToJsonSchema(ShowArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleSessionShow(_args: unknown): Promise<ToolResult> {
  const defaults = getDefaults();
  const toolchain = await probeToolchain();
  const lines: string[] = [];
  lines.push("Session defaults:");
  if (Object.keys(defaults).length === 0) {
    lines.push("  (none — call session_set_defaults to seed)");
  } else {
    for (const [k, v] of Object.entries(defaults)) {
      lines.push(`  ${k}: ${v}`);
    }
  }
  lines.push("");
  lines.push("Toolchain:");
  for (const [name, t] of Object.entries(toolchain.tools)) {
    if (!t.found) {
      lines.push(`  ${name}: NOT FOUND`);
    } else {
      lines.push(`  ${name}: ${t.path}${t.version ? ` (${t.version})` : ""} [${t.source}]`);
    }
  }
  return ok(lines.join("\n"), { defaults, toolchain });
}

const SetArgs = z.object({
  projectDir: z.string().optional().describe("Absolute path to the HarmonyOS project root (contains build-profile.json5)."),
  module: z.string().optional().describe("Module name (e.g. 'entry'). From entry/src/main/module.json5#module.name."),
  bundleName: z.string().optional().describe("App bundle name from AppScope/app.json5#app.bundleName."),
  abilityName: z.string().optional().describe("Main ability name from module.json5#module.mainElement."),
  deviceSn: z.string().optional().describe("hdc device serial. Usually set automatically by emu_start."),
  emulatorName: z.string().optional().describe("Emulator instance name (from emu_list)."),
  buildMode: z.enum(["debug", "release"]).optional().describe("Build mode for hvigorw."),
});

export const sessionSetTool = {
  name: "session_set_defaults",
  description:
    "Set session defaults so subsequent build/install/launch/UI tools can be called with empty args. " +
    "Pass empty string to unset a field. Resolution order: explicit arg > session > error.",
  inputSchema: zodToJsonSchema(SetArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleSessionSet(args: unknown): Promise<ToolResult> {
  const patch = SetArgs.parse(args) as Partial<Defaults>;
  const next = setDefaults(patch);
  return ok(`Defaults updated:\n${JSON.stringify(next, null, 2)}`, { defaults: next });
}

const ClearArgs = z.object({});

export const sessionClearTool = {
  name: "session_clear_defaults",
  description: "Clear all session defaults.",
  inputSchema: zodToJsonSchema(ClearArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleSessionClear(_args: unknown): Promise<ToolResult> {
  clearDefaults();
  return ok("Session defaults cleared.");
}
