import { run, RunResult } from "./exec.js";
import { resolveTool, ToolNotFoundError } from "./toolchain.js";

export function hdcPath(): string {
  const t = resolveTool("hdc");
  if (!t) throw new ToolNotFoundError("hdc");
  return t.path;
}

export async function hdcShell(deviceSn: string, shellCmd: string[], timeoutMs = 30000): Promise<RunResult> {
  return run(hdcPath(), ["-t", deviceSn, "shell", ...shellCmd], { timeoutMs });
}

export async function hdcFileRecv(deviceSn: string, remote: string, local: string, timeoutMs = 30000): Promise<RunResult> {
  return run(hdcPath(), ["-t", deviceSn, "file", "recv", remote, local], { timeoutMs });
}

export async function hdcFileSend(deviceSn: string, local: string, remote: string, timeoutMs = 30000): Promise<RunResult> {
  return run(hdcPath(), ["-t", deviceSn, "file", "send", local, remote], { timeoutMs });
}

export function deviceTmpPath(name: string): string {
  return `/data/local/tmp/${name}`;
}
