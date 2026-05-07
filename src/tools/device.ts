import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { run } from "../lib/exec.js";
import { resolveTool, ToolNotFoundError } from "../lib/toolchain.js";
import { ok, errorResult, ToolResult, truncate } from "../lib/result.js";
import { parseHdcList, summarizeDevices } from "../lib/parsers/hdc.js";

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
