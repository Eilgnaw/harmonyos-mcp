import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform, homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type ToolName = "hdc" | "hvigorw" | "Emulator";

type Resolved = {
  path: string;
  source: "PATH" | "DEVECO_STUDIO_HOME" | "default-install" | "project-local";
};

const isWin = platform() === "win32";

function exeName(name: ToolName): string {
  if (!isWin) return name;
  if (name === "hvigorw") return "hvigorw.bat";
  if (name === "Emulator") return "Emulator.exe";
  return `${name}.exe`;
}

function checkPath(name: ToolName): Resolved | null {
  const file = exeName(name);
  const PATH = process.env.PATH ?? "";
  const sep = isWin ? ";" : ":";
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    const full = join(dir, file);
    if (existsSync(full)) return { path: full, source: "PATH" };
  }
  return null;
}

function devecoRoots(): string[] {
  const roots: string[] = [];
  const env = process.env.DEVECO_STUDIO_HOME;
  if (env) roots.push(env);
  if (isWin) {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    roots.push(join(pf, "Huawei", "DevEco Studio"));
  } else if (platform() === "darwin") {
    roots.push("/Applications/DevEco-Studio.app/Contents");
    roots.push(join(homedir(), "Applications", "DevEco-Studio.app", "Contents"));
  }
  return roots;
}

function resolveInDeveco(name: ToolName, root: string): string | null {
  const file = exeName(name);
  const candidates: string[] = [];
  if (name === "hdc") {
    candidates.push(join(root, "sdk", "default", "openharmony", "toolchains", file));
  } else if (name === "hvigorw") {
    candidates.push(join(root, "tools", "hvigor", "bin", file));
  } else if (name === "Emulator") {
    candidates.push(join(root, "tools", "emulator", file));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

const cache = new Map<ToolName, Resolved>();

export function resolveTool(name: ToolName): Resolved | null {
  const cached = cache.get(name);
  if (cached) return cached;

  const onPath = checkPath(name);
  if (onPath) {
    cache.set(name, onPath);
    return onPath;
  }

  for (const root of devecoRoots()) {
    const path = resolveInDeveco(name, root);
    if (path) {
      const source: Resolved["source"] = process.env.DEVECO_STUDIO_HOME === root ? "DEVECO_STUDIO_HOME" : "default-install";
      const r = { path, source };
      cache.set(name, r);
      return r;
    }
  }

  return null;
}

export function requireTool(name: ToolName): string {
  const r = resolveTool(name);
  if (!r) {
    throw new ToolNotFoundError(name);
  }
  return r.path;
}

export class ToolNotFoundError extends Error {
  constructor(public toolName: ToolName) {
    super(toolNotFoundMessage(toolName));
    this.name = "ToolNotFoundError";
  }
}

function toolNotFoundMessage(name: ToolName): string {
  return [
    `Could not locate '${name}'.`,
    `Tried: PATH, env DEVECO_STUDIO_HOME, default DevEco install paths.`,
    `Fix one of:`,
    `  1. Install DevEco Studio (https://developer.huawei.com/consumer/cn/deveco-studio/) and ensure its CLIs are in PATH.`,
    `  2. Set DEVECO_STUDIO_HOME to your DevEco Studio Contents directory (macOS) or install root (Windows).`,
    `  3. Add the tool to PATH:`,
    `       hdc:      <DevEco>/sdk/default/openharmony/toolchains`,
    `       hvigorw:  <DevEco>/tools/hvigor/bin`,
    `       Emulator: <DevEco>/tools/emulator`,
  ].join("\n");
}

export type ToolchainStatus = {
  ok: boolean;
  tools: Record<ToolName, { found: boolean; path?: string; source?: Resolved["source"]; version?: string; error?: string }>;
};

export async function probeToolchain(): Promise<ToolchainStatus> {
  const tools: ToolchainStatus["tools"] = {} as any;
  for (const name of ["hdc", "hvigorw", "Emulator"] as ToolName[]) {
    const r = resolveTool(name);
    if (!r) {
      tools[name] = { found: false, error: "not found" };
      continue;
    }
    let version: string | undefined;
    try {
      version = await probeVersion(name, r.path);
    } catch {
      // version probe is best-effort
    }
    tools[name] = { found: true, path: r.path, source: r.source, version };
  }
  const ok = (Object.values(tools) as Array<{ found: boolean }>).every((t) => t.found);
  return { ok, tools };
}

async function probeVersion(name: ToolName, path: string): Promise<string | undefined> {
  const args: string[] =
    name === "hdc" ? ["-v"] :
    name === "hvigorw" ? ["--version"] :
    ["-version"];
  try {
    const { stdout, stderr } = await execFileP(path, args, { timeout: 5000 });
    return (stdout || stderr).trim().split("\n")[0];
  } catch (e: any) {
    if (e.stdout || e.stderr) return ((e.stdout || e.stderr) as string).trim().split("\n")[0];
    return undefined;
  }
}
