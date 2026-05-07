import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { run } from "../lib/exec.js";
import { resolveTool, ToolNotFoundError } from "../lib/toolchain.js";
import { ok, errorResult, ToolResult, truncate } from "../lib/result.js";
import { getDefaults } from "../lib/session.js";

const LaunchArgs = z.object({
  bundleName: z.string().optional().describe("App bundle name. Falls back to session.bundleName."),
  abilityName: z.string().optional().describe("Ability name. Falls back to session.abilityName."),
  module: z.string().optional().describe("Module name. Falls back to session.module."),
  deviceSn: z.string().optional().describe("Target hdc serial. Falls back to session.deviceSn."),
});

export const launchTool = {
  name: "launch",
  description:
    "Launch the app's main ability via `hdc shell aa start`. After parse_app_meta + emu_start, " +
    "call with `{}` — all fields default from session.",
  inputSchema: zodToJsonSchema(LaunchArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleLaunch(args: unknown): Promise<ToolResult> {
  const a = LaunchArgs.parse(args);
  const d = getDefaults();
  const bundleName = a.bundleName ?? d.bundleName;
  const abilityName = a.abilityName ?? d.abilityName;
  const moduleName = a.module ?? d.module;
  const deviceSn = a.deviceSn ?? d.deviceSn;

  const missing: string[] = [];
  if (!bundleName) missing.push("bundleName");
  if (!abilityName) missing.push("abilityName");
  if (!moduleName) missing.push("module");
  if (!deviceSn) missing.push("deviceSn");
  if (missing.length > 0) {
    return errorResult(
      `Missing: ${missing.join(", ")}. ` +
      `Run parse_app_meta to seed bundle/ability/module, and emu_start to set deviceSn.`
    );
  }

  const tool = resolveTool("hdc");
  if (!tool) return errorResult(new ToolNotFoundError("hdc").message);

  const cliArgs = [
    "-t", deviceSn!,
    "shell", "aa", "start",
    "-a", abilityName!,
    "-b", bundleName!,
    "-m", moduleName!,
  ];

  const r = await run(tool.path, cliArgs, { timeoutMs: 30000 });
  const combined = `${r.stdout}\n${r.stderr}`.trim();
  const success = r.exitCode === 0 && /start ability successfully|success/i.test(combined);
  if (!success) {
    return errorResult(`Launch failed (exit ${r.exitCode}):\n${truncate(combined)}`);
  }
  return ok(
    `Launched ${bundleName}/${moduleName}/${abilityName} on ${deviceSn}\n${combined}`,
    { bundleName, abilityName, module: moduleName, deviceSn }
  );
}
