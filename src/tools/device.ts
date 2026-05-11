import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { run } from "../lib/exec.js";
import { resolveTool, ToolNotFoundError } from "../lib/toolchain.js";
import { ok, errorResult, ToolResult, truncate } from "../lib/result.js";
import { parseHdcList, summarizeDevices } from "../lib/parsers/hdc.js";
import { hdcShell } from "../lib/hdc.js";
import { getDefaults } from "../lib/session.js";

const ListArgs = z.object({});

export const deviceListTool = {
  name: "device_list",
  description:
    "List devices currently visible to hdc (running emulators or attached phones). " +
    "Wraps `hdc list targets`. No args.",
  inputSchema: zodToJsonSchema(ListArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleDeviceList(_args: unknown): Promise<ToolResult> {
  const tool = resolveTool("hdc");
  if (!tool) return errorResult(new ToolNotFoundError("hdc").message);
  const r = await run(tool.path, ["list", "targets"], { timeoutMs: 5000 });
  if (r.exitCode !== 0) {
    return errorResult(`hdc list targets failed (exit ${r.exitCode}):\n${truncate(r.stderr || r.stdout)}`);
  }
  const devices = parseHdcList(r.stdout);
  return ok(summarizeDevices(devices), { devices });
}

// ---------- app_state ----------

const AppStateArgs = z.object({
  deviceSn: z.string().optional(),
  bundleName: z.string().optional().describe("If set, also report whether this bundle is currently in the foreground. Falls back to session.bundleName."),
});

export const appStateTool = {
  name: "app_state",
  description:
    "Report the foreground app on the device — bundle / ability / module / pid — via `aa dump -l`. " +
    "Cheap state check; prefer over screenshot when you only need to confirm \"are we in the right page yet?\".",
  inputSchema: zodToJsonSchema(AppStateArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleAppState(args: unknown): Promise<ToolResult> {
  const a = AppStateArgs.parse(args);
  const sn = a.deviceSn ?? getDefaults().deviceSn;
  if (!sn) return errorResult("No deviceSn.");

  const r = await hdcShell(sn, ["aa", "dump", "-l"], 15000);
  if (r.exitCode !== 0) {
    return errorResult(`aa dump -l failed (exit ${r.exitCode}):\n${truncate(r.stderr || r.stdout)}`);
  }

  const parsed = parseForegroundAbility(r.stdout);
  const targetBundle = a.bundleName ?? getDefaults().bundleName;
  const isTarget = targetBundle && parsed?.bundleName ? parsed.bundleName === targetBundle : undefined;

  if (!parsed) {
    return ok(
      `No foreground ability detected. Raw output (truncated):\n${truncate(r.stdout, 2000)}`,
      { foreground: null, isTargetBundle: isTarget }
    );
  }

  const lines = [
    `Foreground on ${sn}:`,
    `  bundle:  ${parsed.bundleName ?? "?"}`,
    `  ability: ${parsed.abilityName ?? "?"}`,
    `  module:  ${parsed.moduleName ?? "?"}`,
    `  pid:     ${parsed.pid ?? "?"}`,
  ];
  if (isTarget !== undefined) {
    lines.push(`  matches ${targetBundle}: ${isTarget ? "yes" : "no"}`);
  }
  return ok(lines.join("\n"), { foreground: parsed, isTargetBundle: isTarget });
}

type Foreground = {
  bundleName?: string;
  abilityName?: string;
  moduleName?: string;
  pid?: number;
};

function parseForegroundAbility(output: string): Foreground | null {
  const lines = output.split("\n");

  let fgIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/\bstate\s+#FOREGROUND\b/i.test(lines[i])) { fgIdx = i; break; }
  }

  if (fgIdx >= 0) {
    const window = lines.slice(Math.max(0, fgIdx - 20), fgIdx + 20).join("\n");
    const bundle = window.match(/bundle\s*name\s*\[([^\]]+)\]/i)
      ?? window.match(/bundleName[:\s]+([^\s,}]+)/);
    const ability = window.match(/main\s*name\s*\[([^\]]+)\]/i)
      ?? window.match(/ability\s*name\s*\[([^\]]+)\]/i)
      ?? window.match(/abilityName[:\s]+([^\s,}]+)/);
    const moduleName = window.match(/module\s*name\s*\[([^\]]+)\]/i)
      ?? window.match(/moduleName[:\s]+([^\s,}]+)/)
      // HOS ≥6 puts `bundle:module:ability` inside the mission name line.
      ?? window.match(/mission\s*name\s*#?\[#?[^:\]]+:([^:\]]+):[^:\]]+\]/i);
    const pid = window.match(/\bpid\s*#(\d+)/i) ?? window.match(/\bpid[:\s]+(\d+)/i);
    const result: Foreground = {
      bundleName: bundle?.[1],
      abilityName: ability?.[1],
      moduleName: moduleName?.[1],
      pid: pid ? Number(pid[1]) : undefined,
    };
    if (result.bundleName || result.abilityName) return result;
  }

  for (const line of lines) {
    const m = line.match(/topAbility[^{]*\{[^}]*bundleName:\s*([^,\s}]+)[^}]*abilityName:\s*([^,\s}]+)/i);
    if (m) return { bundleName: m[1], abilityName: m[2] };
  }
  return null;
}
