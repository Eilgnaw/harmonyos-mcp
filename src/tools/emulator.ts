import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { spawn } from "node:child_process";
import { run } from "../lib/exec.js";
import { resolveTool, ToolNotFoundError } from "../lib/toolchain.js";
import { ok, errorResult, ToolResult, truncate } from "../lib/result.js";
import { parseEmulatorList, summarizeEmulators } from "../lib/parsers/emulator.js";
import { parseHdcList } from "../lib/parsers/hdc.js";
import { setDefaults } from "../lib/session.js";

const ListArgs = z.object({});

export const emuListTool = {
  name: "emu_list",
  description:
    "List local HarmonyOS emulator instances (name, deviceType, osVersion, running state). " +
    "Wraps `Emulator -list -details`. No args.",
  inputSchema: zodToJsonSchema(ListArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleEmuList(_args: unknown): Promise<ToolResult> {
  const tool = resolveTool("Emulator");
  if (!tool) return errorResult(new ToolNotFoundError("Emulator").message);
  const r = await run(tool.path, ["-list", "-details"], { timeoutMs: 15000 });
  if (r.exitCode !== 0) {
    return errorResult(`Emulator -list failed (exit ${r.exitCode}):\n${truncate(r.stderr || r.stdout)}`);
  }
  let parsed;
  try {
    parsed = parseEmulatorList(r.stdout);
  } catch (e: any) {
    return errorResult(`Could not parse Emulator output as JSON: ${e.message}\n\n${truncate(r.stdout)}`);
  }
  return ok(summarizeEmulators(parsed), { instances: parsed });
}

const StartArgs = z.object({
  name: z.string().describe("Emulator instance name, as shown in emu_list."),
  hdcPort: z.number().int().min(10000).max(16555).optional().describe("Optional hdc port; default chosen by Emulator."),
  waitForHdcMs: z.number().int().min(0).max(120000).optional().describe("Max ms to wait for the device to appear in `hdc list targets`. Default 60000. Pass 0 to skip the wait."),
});

export const emuStartTool = {
  name: "emu_start",
  description:
    "Start a HarmonyOS emulator in the background and (by default) wait until hdc can see it. " +
    "Wraps `Emulator -start <name>`. On success, sets session deviceSn to the new hdc target.",
  inputSchema: zodToJsonSchema(StartArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleEmuStart(args: unknown): Promise<ToolResult> {
  const a = StartArgs.parse(args);
  const emu = resolveTool("Emulator");
  const hdc = resolveTool("hdc");
  if (!emu) return errorResult(new ToolNotFoundError("Emulator").message);
  if (!hdc) return errorResult(new ToolNotFoundError("hdc").message);

  const before = new Set((await listHdcSerials(hdc.path)) ?? []);

  const cmdArgs = ["-start", a.name];
  if (a.hdcPort !== undefined) cmdArgs.push("-hdcport", String(a.hdcPort));

  const child = spawn(emu.path, cmdArgs, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let earlyOut = "";
  child.stdout?.on("data", (c) => { earlyOut += c.toString(); });
  child.stderr?.on("data", (c) => { earlyOut += c.toString(); });

  const earlyExit = await Promise.race([
    new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
  ]);

  if (earlyExit !== null && earlyExit !== 0) {
    return errorResult(`Emulator failed to start (exit ${earlyExit}):\n${truncate(earlyOut)}`);
  }

  child.unref();

  const wait = a.waitForHdcMs ?? 60000;
  if (wait === 0) {
    return ok(
      `Emulator '${a.name}' launching. Skipped wait (waitForHdcMs=0). Call device_list later to confirm.`,
      { name: a.name, waited: false }
    );
  }

  const newSerial = await pollForNewSerial(hdc.path, before, wait);
  if (!newSerial) {
    return errorResult(
      `Emulator '${a.name}' was launched but did not appear in 'hdc list targets' within ${wait}ms.\n` +
      `Check DevEco Studio Device Manager for status, or rerun emu_start with a longer waitForHdcMs.\n` +
      `Recent Emulator output:\n${truncate(earlyOut)}`
    );
  }
  setDefaults({ deviceSn: newSerial, emulatorName: a.name });
  return ok(
    `Emulator '${a.name}' started. Device serial: ${newSerial}\nSession deviceSn set.`,
    { name: a.name, deviceSn: newSerial }
  );
}

const StopArgs = z.object({
  name: z.string().describe("Emulator instance name to stop."),
});

export const emuStopTool = {
  name: "emu_stop",
  description: "Stop a running HarmonyOS emulator. Wraps `Emulator -stop <name>`.",
  inputSchema: zodToJsonSchema(StopArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleEmuStop(args: unknown): Promise<ToolResult> {
  const a = StopArgs.parse(args);
  const tool = resolveTool("Emulator");
  if (!tool) return errorResult(new ToolNotFoundError("Emulator").message);
  const r = await run(tool.path, ["-stop", a.name], { timeoutMs: 30000 });
  if (r.exitCode !== 0) {
    return errorResult(`Emulator -stop failed (exit ${r.exitCode}):\n${truncate(r.stderr || r.stdout)}`);
  }
  return ok(`Emulator '${a.name}' stopped.\n${r.stdout.trim()}`);
}

async function listHdcSerials(hdcPath: string): Promise<string[] | null> {
  try {
    const r = await run(hdcPath, ["list", "targets"], { timeoutMs: 5000 });
    return parseHdcList(r.stdout).map((d) => d.serial);
  } catch {
    return null;
  }
}

async function pollForNewSerial(hdcPath: string, before: Set<string>, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await listHdcSerials(hdcPath);
    if (now) {
      const fresh = now.find((s) => !before.has(s));
      if (fresh) return fresh;
    }
    await delay(2000);
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
