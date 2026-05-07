import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ok, errorResult, ToolResult } from "../lib/result.js";
import { findProjectRoots, loadProjectInfo, pickEntryModule, summarizeProject } from "../lib/project.js";
import { setDefaults, getDefaults } from "../lib/session.js";

const DiscoverArgs = z.object({
  rootDir: z.string().describe("Directory to scan recursively for HarmonyOS project roots."),
  maxDepth: z.number().int().min(1).max(10).optional().describe("Max recursion depth. Default 4."),
});

export const discoverProjectTool = {
  name: "discover_project",
  description:
    "Scan a directory for HarmonyOS project roots (folders containing build-profile.json5). Returns paths only.",
  inputSchema: zodToJsonSchema(DiscoverArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleDiscoverProject(args: unknown): Promise<ToolResult> {
  const a = DiscoverArgs.parse(args);
  const found = findProjectRoots(a.rootDir, a.maxDepth);
  if (found.length === 0) {
    return ok(`No HarmonyOS project roots found under ${a.rootDir}.`, { projectRoots: [] });
  }
  return ok(`Found ${found.length} project root(s):\n${found.join("\n")}`, { projectRoots: found });
}

const ParseArgs = z.object({
  projectDir: z.string().optional().describe("Project root. Falls back to session.projectDir."),
  applyToSession: z.boolean().optional().describe("If true (default), seed session defaults with bundleName / module / abilityName."),
});

export const parseAppMetaTool = {
  name: "parse_app_meta",
  description:
    "Read AppScope/app.json5 + each module's module.json5, return bundleName / modules / abilities. " +
    "By default also seeds session defaults so subsequent build/launch calls can be empty-arg.",
  inputSchema: zodToJsonSchema(ParseArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleParseAppMeta(args: unknown): Promise<ToolResult> {
  const a = ParseArgs.parse(args);
  const projectDir = a.projectDir ?? getDefaults().projectDir;
  if (!projectDir) {
    return errorResult(
      "No projectDir. Pass it explicitly or call session_set_defaults with { projectDir } first."
    );
  }
  let info;
  try {
    info = loadProjectInfo(projectDir);
  } catch (e: any) {
    return errorResult(`Failed to load project: ${e.message}`);
  }

  const apply = a.applyToSession ?? true;
  if (apply) {
    const entry = pickEntryModule(info);
    setDefaults({
      projectDir,
      module: entry?.name,
      bundleName: info.app?.bundleName,
      abilityName: entry?.mainElement,
    });
  }

  return ok(summarizeProject(info), {
    projectInfo: info,
    sessionApplied: apply,
  });
}
