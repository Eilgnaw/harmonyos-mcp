import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../lib/exec.js";
import { resolveTool, ToolNotFoundError } from "../lib/toolchain.js";
import { ok, errorResult, ToolResult, truncate } from "../lib/result.js";
import { getDefaults } from "../lib/session.js";
import { loadProjectInfo } from "../lib/project.js";
import { parseBuildOutput, summarizeBuild } from "../lib/parsers/build.js";

const BuildArgs = z.object({
  projectDir: z.string().optional(),
  module: z.string().optional().describe("Module name to build (e.g. 'entry'). Falls back to session.module."),
  product: z.string().optional().describe("Product name from build-profile.json5#app.products. Default 'default'."),
  buildMode: z.enum(["debug", "release"]).optional().describe("Default 'debug'."),
  clean: z.boolean().optional().describe("Run `hvigorw clean` before assembling. Default false."),
  task: z.string().optional().describe("Override hvigor task. Default 'assembleHap'."),
});

export const buildTool = {
  name: "build",
  description:
    "Build a HAP via hvigorw. Returns parsed errors/warnings and the HAP path on success. " +
    "Most fields default to session — typical call after parse_app_meta is `{}`.",
  inputSchema: zodToJsonSchema(BuildArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleBuild(args: unknown): Promise<ToolResult> {
  const a = BuildArgs.parse(args);
  const d = getDefaults();
  const projectDir = a.projectDir ?? d.projectDir;
  if (!projectDir) {
    return errorResult("No projectDir. Call session_set_defaults with { projectDir } or pass it explicitly.");
  }
  const moduleName = a.module ?? d.module;
  if (!moduleName) {
    return errorResult("No module. Pass `module` or set session.module via parse_app_meta.");
  }
  const product = a.product ?? "default";
  const buildMode = a.buildMode ?? d.buildMode ?? "debug";

  const tool = resolveTool("hvigorw");
  if (!tool) return errorResult(new ToolNotFoundError("hvigorw").message);

  if (a.clean) {
    const cleanRun = await run(tool.path, ["clean", "--no-daemon"], {
      cwd: projectDir,
      timeoutMs: 120000,
    });
    if (cleanRun.exitCode !== 0) {
      return errorResult(`hvigorw clean failed (exit ${cleanRun.exitCode}):\n${truncate(cleanRun.stderr || cleanRun.stdout)}`);
    }
  }

  const task = a.task ?? "assembleHap";
  const cliArgs = [
    task,
    "--mode", "module",
    "-p", `module=${moduleName}@${product}`,
    "-p", `product=${product}`,
    "-p", `buildMode=${buildMode}`,
    "--no-daemon",
  ];

  const r = await run(tool.path, cliArgs, {
    cwd: projectDir,
    timeoutMs: 600000,
  });

  const combined = `${r.stdout}\n${r.stderr}`;
  const parsed = parseBuildOutput(combined);
  const success = r.exitCode === 0 && parsed.success;

  let hapPath: string | undefined;
  if (success) {
    hapPath = locateHap(projectDir, moduleName, product);
  }

  const summary = summarizeBuild(parsed);
  const tail = success && hapPath ? `\n\nHAP: ${hapPath}` : "";

  return {
    content: [{ type: "text", text: `${summary}${tail}` }],
    isError: !success,
    structuredContent: {
      success,
      hapPath,
      durationMs: r.durationMs,
      issues: parsed.issues,
    },
  };
}

function locateHap(projectDir: string, moduleName: string, product: string): string | undefined {
  let info;
  try {
    info = loadProjectInfo(projectDir);
  } catch {
    return undefined;
  }
  const mod = info.modules.find((m) => m.name === moduleName);
  if (!mod) return undefined;
  const moduleDir = resolve(projectDir, mod.srcPath);
  const candidates = [
    join(moduleDir, "build", product, "outputs", product, `${moduleName}-${product}-signed.hap`),
    join(moduleDir, "build", product, "outputs", product, `${moduleName}-${product}-unsigned.hap`),
  ];
  return candidates.find((p) => existsSync(p));
}
