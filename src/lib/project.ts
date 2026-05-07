import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readJson5 } from "./json5lite.js";

export type AppMeta = {
  bundleName?: string;
  versionName?: string;
  vendor?: string;
};

export type ModuleMeta = {
  name: string;
  type?: string;
  srcPath: string;
  mainElement?: string;
  abilities: { name: string; srcEntry?: string; exported?: boolean }[];
};

export type ProjectInfo = {
  projectDir: string;
  buildProfilePath: string;
  app?: AppMeta;
  modules: ModuleMeta[];
  signingConfigured: boolean;
};

const PROJECT_MARKER = "build-profile.json5";
const SKIP_DIRS = new Set([
  "node_modules", "oh_modules", ".hvigor", ".idea", "build",
  "dist", ".git", ".svn", ".cxx",
]);

export function findProjectRoots(rootDir: string, maxDepth = 4): string[] {
  const start = resolve(rootDir);
  const found: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    if (existsSync(join(dir, PROJECT_MARKER))) {
      // Don't recurse into a project root.
      found.push(dir);
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e)) continue;
      if (e.startsWith(".")) continue;
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full, depth + 1);
    }
  }

  walk(start, 0);
  return found;
}

export function loadProjectInfo(projectDir: string): ProjectInfo {
  const buildProfilePath = join(projectDir, PROJECT_MARKER);
  if (!existsSync(buildProfilePath)) {
    throw new Error(`Not a HarmonyOS project root (no build-profile.json5): ${projectDir}`);
  }
  const profile = readJson5(buildProfilePath) as any;

  const app = readAppMeta(projectDir);

  const modulesFromProfile = (profile?.modules ?? []) as Array<{ name: string; srcPath: string }>;
  const modules: ModuleMeta[] = [];
  for (const m of modulesFromProfile) {
    const srcPath = m.srcPath ?? `./${m.name}`;
    const moduleDir = resolve(projectDir, srcPath);
    const moduleJson = join(moduleDir, "src", "main", "module.json5");
    if (!existsSync(moduleJson)) {
      modules.push({ name: m.name, srcPath, abilities: [] });
      continue;
    }
    try {
      const parsed = readJson5(moduleJson) as any;
      const mod = parsed?.module ?? {};
      modules.push({
        name: mod.name ?? m.name,
        type: mod.type,
        srcPath,
        mainElement: mod.mainElement,
        abilities: Array.isArray(mod.abilities)
          ? mod.abilities.map((a: any) => ({
              name: a.name,
              srcEntry: a.srcEntry,
              exported: a.exported,
            }))
          : [],
      });
    } catch {
      modules.push({ name: m.name, srcPath, abilities: [] });
    }
  }

  const signingConfigured = Array.isArray(profile?.app?.signingConfigs) && profile.app.signingConfigs.length > 0;

  return { projectDir, buildProfilePath, app, modules, signingConfigured };
}

function readAppMeta(projectDir: string): AppMeta | undefined {
  const appJson = join(projectDir, "AppScope", "app.json5");
  if (!existsSync(appJson)) return undefined;
  try {
    const parsed = readJson5(appJson) as any;
    const app = parsed?.app ?? {};
    return {
      bundleName: app.bundleName,
      versionName: app.versionName,
      vendor: app.vendor,
    };
  } catch {
    return undefined;
  }
}

export function pickEntryModule(info: ProjectInfo): ModuleMeta | undefined {
  const entry = info.modules.find((m) => m.type === "entry");
  if (entry) return entry;
  return info.modules.find((m) => m.name === "entry") ?? info.modules[0];
}

export function summarizeProject(info: ProjectInfo): string {
  const lines: string[] = [];
  lines.push(`Project: ${info.projectDir}`);
  if (info.app?.bundleName) lines.push(`  bundleName: ${info.app.bundleName}`);
  if (info.app?.versionName) lines.push(`  versionName: ${info.app.versionName}`);
  lines.push(`  signingConfigured: ${info.signingConfigured}`);
  lines.push(`  modules:`);
  for (const m of info.modules) {
    const main = m.mainElement ? ` mainElement=${m.mainElement}` : "";
    const type = m.type ? ` type=${m.type}` : "";
    lines.push(`    - ${m.name}${type}${main}`);
    for (const a of m.abilities) {
      lines.push(`        ability: ${a.name}${a.exported ? " (exported)" : ""}`);
    }
  }
  return lines.join("\n");
}
