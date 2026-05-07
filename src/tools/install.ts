import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { existsSync } from "node:fs";
import { run } from "../lib/exec.js";
import { resolveTool, ToolNotFoundError } from "../lib/toolchain.js";
import { ok, errorResult, ToolResult, truncate } from "../lib/result.js";
import { getDefaults } from "../lib/session.js";

const InstallArgs = z.object({
  hapPath: z.string().describe("Absolute path to a .hap file. Build returns this in structuredContent.hapPath."),
  deviceSn: z.string().optional().describe("Target hdc serial. Falls back to session.deviceSn."),
  replace: z.boolean().optional().describe("Pass -r to overwrite existing install. Default true."),
});

export const installTool = {
  name: "install",
  description: "Install a built HAP onto a connected device or running emulator via hdc.",
  inputSchema: zodToJsonSchema(InstallArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleInstall(args: unknown): Promise<ToolResult> {
  const a = InstallArgs.parse(args);
  const deviceSn = a.deviceSn ?? getDefaults().deviceSn;
  if (!deviceSn) {
    return errorResult(
      "No deviceSn. Start an emulator with emu_start (auto-sets it), or pass deviceSn explicitly. " +
      "Use device_list to see available targets."
    );
  }
  if (!existsSync(a.hapPath)) {
    return errorResult(`HAP not found at: ${a.hapPath}`);
  }

  const tool = resolveTool("hdc");
  if (!tool) return errorResult(new ToolNotFoundError("hdc").message);

  const replace = a.replace ?? true;
  const cliArgs = ["-t", deviceSn, "install", ...(replace ? ["-r"] : []), a.hapPath];

  const r = await run(tool.path, cliArgs, { timeoutMs: 120000 });
  const combined = `${r.stdout}\n${r.stderr}`.trim();

  const success = r.exitCode === 0 && /install bundle successfully|installation success|success/i.test(combined);

  if (!success) {
    return errorResult(`Install failed (exit ${r.exitCode}):\n${truncate(combined)}`);
  }
  return ok(`Installed to ${deviceSn}\n${combined}`, { deviceSn, hapPath: a.hapPath });
}
