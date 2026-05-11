import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { hdcFileRecv } from "../lib/hdc.js";
import { ok, errorResult, ToolResult, truncate } from "../lib/result.js";
import { getDefaults } from "../lib/session.js";

const PullFileArgs = z.object({
  remotePath: z.string().describe("Absolute path on the device (e.g. /data/app/.../databases/foo.db, /data/local/tmp/x.png, /data/storage/...)."),
  localPath: z.string().describe("Absolute local destination path."),
  deviceSn: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional().describe("Default 60000."),
});

export const pullFileTool = {
  name: "pull_file",
  description:
    "Copy a file from the device to the host via `hdc file recv`. " +
    "Use for sqlite/db files, log files, crash dumps, screenshots/recordings, sandbox config, etc.",
  inputSchema: zodToJsonSchema(PullFileArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handlePullFile(args: unknown): Promise<ToolResult> {
  const a = PullFileArgs.parse(args);
  const sn = a.deviceSn ?? getDefaults().deviceSn;
  if (!sn) return errorResult("No deviceSn.");
  if (!isAbsolute(a.remotePath)) {
    return errorResult(`remotePath must be absolute. Got: ${a.remotePath}`);
  }
  if (!isAbsolute(a.localPath)) {
    return errorResult(`localPath must be absolute. Got: ${a.localPath}`);
  }

  const r = await hdcFileRecv(sn, a.remotePath, a.localPath, a.timeoutMs ?? 60000);
  if (r.exitCode !== 0) {
    return errorResult(
      `hdc file recv failed (exit ${r.exitCode}):\n${truncate((r.stderr || r.stdout).trim())}`
    );
  }

  let sizeBytes: number | undefined;
  try { sizeBytes = statSync(a.localPath).size; } catch { /* path may be a dir or not exist */ }
  const sizeText = sizeBytes !== undefined ? ` (${sizeBytes} bytes)` : "";

  return ok(`Pulled ${a.remotePath} -> ${a.localPath}${sizeText}`, {
    remotePath: a.remotePath,
    localPath: a.localPath,
    sizeBytes,
  });
}
