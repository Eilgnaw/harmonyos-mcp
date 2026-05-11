import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { ok, errorResult, okWith, ToolResult, truncate } from "../lib/result.js";
import { getDefaults } from "../lib/session.js";
import { hdcShell, hdcFileRecv, deviceTmpPath } from "../lib/hdc.js";
import { centerOf, parseBounds, renderTree, slimDump, type SlimNode } from "../lib/parsers/uiDump.js";

function sessionDevice(explicit?: string): string | null {
  return explicit ?? getDefaults().deviceSn ?? null;
}

function localTmp(suffix: string): string {
  const dir = join(tmpdir(), "harmonyos-mcp");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${randomUUID().slice(0, 8)}-${suffix}`);
}

// ---------- screenshot ----------

const ScreenshotArgs = z.object({
  deviceSn: z.string().optional(),
  savePath: z.string().optional().describe("If set, also keep a copy at this local path. Saved copy is the original PNG. Use this for a permanent record only — DO NOT read this file back via your file-read tool to look at the UI; the embedded image already in the response is the canonical view."),
  embedImage: z.boolean().optional().describe("If true (default), include the downscaled JPEG as image content. Set false only when you don't need to look at the screen now (e.g. archival capture)."),
  maxDimension: z.number().int().min(64).max(4096).optional().describe("Max width/height for the embedded image, in px. Default 1080. Token cost scales with dimensions, so smaller = cheaper. Set 0 to disable resize."),
  quality: z.number().int().min(1).max(100).optional().describe("JPEG quality for the embedded image (1-100). Default 70."),
  raw: z.boolean().optional().describe("Skip compression and embed the raw PNG. Default false. Avoid unless you genuinely need pixel-perfect detail (1px borders, tiny glyphs) — the raw PNG is multi-MB and burns context."),
});

export const screenshotTool = {
  name: "screenshot",
  description: [
    "Capture the current screen. Use sparingly — screenshots are the most expensive way to inspect the device.",
    "Before reaching for screenshot, ask whether a cheaper tool can answer the same question:",
    "- 'Did the tap work / am I on the right page?' → `app_state` or `wait_for_ui` (text-only, deterministic).",
    "- 'What's tappable on screen / what's the text of element X?' → `find_ui` or `ui_dump`.",
    "- 'Did loading finish?' → `wait_for_ui { ..., condition: \"absent\" }` on the spinner/text.",
    "- 'Did an event happen inside the app?' → `wait_for_log`.",
    "Reserve screenshot for visual checks that text-based tools can't answer: animations, layout/alignment, rendering glitches, icon/image correctness, or one-shot 'show me the screen' debugging.",
    "Default behavior: returns a downscaled (maxDimension 1080) JPEG (quality 70) embedded directly in the tool response — this is the image you should look at to judge UI state. Typical embed is 15–35 KB.",
    "DO NOT separately read the file at savePath via a file-read tool after calling this — that re-ingests the same screenshot at full 1256×~2760 PNG resolution (often several MB) and doubles token cost for zero new information. The embedded JPEG is already there.",
    "Only fall back to reading the saved PNG (or passing raw:true) when you genuinely need pixel-perfect detail the JPEG hides (1px borders, tiny glyph anti-aliasing).",
    "Pass embedImage:false only when you're capturing for archival and don't need to look at the screen this turn.",
  ].join(" "),
  inputSchema: zodToJsonSchema(ScreenshotArgs, { target: "openApi3" }) as Record<string, unknown>,
};

async function compressForEmbed(
  pngPath: string, maxDim: number, quality: number
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    let pipeline = sharp(pngPath);
    if (maxDim > 0) {
      pipeline = pipeline.resize({
        width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true,
      });
    }
    const buffer = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    return { buffer, mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

export async function handleScreenshot(args: unknown): Promise<ToolResult> {
  const a = ScreenshotArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn. Use emu_start or pass deviceSn.");

  const remoteName = `mcp_${Date.now()}.png`;
  const remote = deviceTmpPath(remoteName);

  const cap = await hdcShell(sn, ["uitest", "screenCap", "-p", remote], 15000);
  if (cap.exitCode !== 0) {
    return errorResult(`screenCap failed (exit ${cap.exitCode}):\n${truncate(cap.stderr || cap.stdout)}`);
  }

  const local = a.savePath ?? localTmp("screen.png");
  const recv = await hdcFileRecv(sn, remote, local, 30000);
  if (recv.exitCode !== 0) {
    return errorResult(`hdc file recv failed (exit ${recv.exitCode}):\n${truncate(recv.stderr || recv.stdout)}`);
  }

  await hdcShell(sn, ["rm", "-f", remote], 5000).catch(() => undefined);

  const embed = a.embedImage ?? true;
  const stat = statSync(local);
  const origKb = Math.round(stat.size / 1024);

  if (!embed) {
    return ok(`Screenshot saved: ${local} (${origKb} KB)`, { localPath: local, sizeBytes: stat.size });
  }

  let embedBuf: Buffer;
  let embedMime = "image/png";
  if (!(a.raw ?? false)) {
    const compressed = await compressForEmbed(local, a.maxDimension ?? 1080, a.quality ?? 70);
    if (compressed) {
      embedBuf = compressed.buffer;
      embedMime = compressed.mimeType;
    } else {
      embedBuf = readFileSync(local);
    }
  } else {
    embedBuf = readFileSync(local);
  }

  const embedKb = Math.round(embedBuf.length / 1024);
  const data = embedBuf.toString("base64");

  if (!a.savePath) {
    try { unlinkSync(local); } catch { /* best effort */ }
  }

  const compressedNote = embedMime === "image/jpeg"
    ? ` (compressed from ${origKb} KB PNG)`
    : "";
  return okWith(
    [
      { type: "text", text: `Screenshot ${embedKb} KB${compressedNote}${a.savePath ? `, original saved to ${local}` : ""}.` },
      { type: "image", data, mimeType: embedMime },
    ],
    {
      localPath: a.savePath ? local : undefined,
      sizeBytes: stat.size,
      embedSizeBytes: embedBuf.length,
      embedMime,
    }
  );
}

// ---------- ui_dump ----------

const UiScopeFields = {
  deviceSn: z.string().optional(),
  bundleFilter: z.string().optional().describe("Restrict to one app by bundle name. Defaults to session.bundleName when set."),
  noBundleFilter: z.boolean().optional().describe("Set true to skip the bundleFilter default and dump everything."),
  onlyInteractive: z.boolean().optional().describe("Drop decorative nodes (default false)."),
  compact: z.boolean().optional().describe("Collapse pass-through containers and empty wrappers (default true). Set false for full structure."),
};

const UiDumpArgs = z.object({
  ...UiScopeFields,
  groupSiblings: z.boolean().optional().describe("Group ≥3 consecutive same-shape siblings into compact rows showing only their bounds + leaf text (default true)."),
  format: z.enum(["tree", "json"]).optional().describe("Output format. 'tree' (default) is most readable for LLMs."),
});

const UiMatchFields = {
  text: z.string().optional().describe("Exact text match."),
  textContains: z.string().optional().describe("Substring match against node text."),
  id: z.string().optional().describe("Exact id match."),
  descriptionContains: z.string().optional().describe("Substring match against accessibility description."),
  type: z.string().optional().describe("Exact node type match."),
  clickable: z.boolean().optional().describe("Whether the node itself should be clickable."),
};

const FindUiArgs = z.object({
  ...UiScopeFields,
  ...UiMatchFields,
  limit: z.number().int().min(1).max(50).optional().describe("Max matches to return. Default 10."),
}).refine(hasUiMatcher, {
  message: "At least one matcher is required: text, textContains, id, descriptionContains, type, or clickable.",
});

const TapTextArgs = z.object({
  ...UiScopeFields,
  text: z.string().min(1).describe("Target text to find."),
  matchMode: z.enum(["exact", "contains"]).optional().describe("Text matching mode. Default exact."),
  index: z.number().int().min(0).optional().describe("Which match to tap when multiple nodes match. Default 0."),
});

const WaitForUiArgs = z.object({
  ...UiScopeFields,
  ...UiMatchFields,
  condition: z.enum(["present", "absent"]).optional().describe("Whether to wait until the match appears or disappears. Default present."),
  timeoutMs: z.number().int().min(500).max(120000).optional().describe("Overall timeout. Default 10000."),
  intervalMs: z.number().int().min(200).max(5000).optional().describe("Polling interval. Default 1000."),
}).refine(hasUiMatcher, {
  message: "At least one matcher is required: text, textContains, id, descriptionContains, type, or clickable.",
});

export const uiDumpTool = {
  name: "ui_dump",
  description:
    "Dump the current control tree (uitest dumpLayout). Slimmed: keeps type/text/id/desc/bounds and " +
    "interactive flags. By default filters to session.bundleName.",
  inputSchema: zodToJsonSchema(UiDumpArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export const findUiTool = {
  name: "find_ui",
  description:
    "Query the current UI tree and return only matching nodes instead of the full dump. " +
    "Matches exact text/id/type, text/description contains, and/or clickable state.",
  inputSchema: zodToJsonSchema(FindUiArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export const tapTextTool = {
  name: "tap_text",
  description:
    "Find a node by text and tap it. If the text leaf is not clickable, taps the nearest clickable ancestor.",
  inputSchema: zodToJsonSchema(TapTextArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export const waitForUiTool = {
  name: "wait_for_ui",
  description:
    "Poll the current UI tree until a match appears or disappears. Useful after navigation, loading, or async UI updates.",
  inputSchema: zodToJsonSchema(WaitForUiArgs, { target: "openApi3" }) as Record<string, unknown>,
};

type UiTreeArgs = z.infer<typeof UiDumpArgs>;
type UiQuery = {
  text?: string;
  textContains?: string;
  id?: string;
  descriptionContains?: string;
  type?: string;
  clickable?: boolean;
};

type UiMatch = {
  path: string;
  node: SlimNode;
  center: { x: number; y: number } | null;
  tapNode: SlimNode | null;
  tapCenter: { x: number; y: number } | null;
};

async function loadUiTree(args: UiTreeArgs): Promise<
  { tree: SlimNode; bundleFilter?: string; rawKb: number; viewport: Viewport }
  | { error: string }
> {
  const sn = sessionDevice(args.deviceSn);
  if (!sn) return { error: "No deviceSn. Use emu_start or pass deviceSn." };

  const bundleFilter = args.noBundleFilter ? undefined : (args.bundleFilter ?? getDefaults().bundleName);
  const remoteName = `mcp_dump_${Date.now()}.json`;
  const remote = deviceTmpPath(remoteName);
  const local = localTmp("dump.json");

  const dump = await hdcShell(
    sn,
    ["uitest", "dumpLayout", "-p", remote, ...(bundleFilter ? ["-b", bundleFilter] : [])],
    20000
  );
  if (dump.exitCode !== 0) {
    return { error: `dumpLayout failed (exit ${dump.exitCode}):\n${truncate(dump.stderr || dump.stdout)}` };
  }

  try {
    const recv = await hdcFileRecv(sn, remote, local, 30000);
    if (recv.exitCode !== 0) {
      return { error: `hdc file recv failed (exit ${recv.exitCode}):\n${truncate(recv.stderr || recv.stdout)}` };
    }

    const raw = readFileSync(local, "utf8");
    try {
      const { tree, screenBounds } = slimDump(raw, {
        bundleFilter,
        onlyInteractive: args.onlyInteractive ?? false,
        compact: args.compact ?? true,
      });
      const viewport = computeViewport(tree, screenBounds);
      return { tree, bundleFilter, rawKb: Math.round(raw.length / 1024), viewport };
    } catch (e: any) {
      return { error: `Failed to parse dump JSON: ${e.message}` };
    }
  } finally {
    await hdcShell(sn, ["rm", "-f", remote], 5000).catch(() => undefined);
    try { unlinkSync(local); } catch { /* best effort */ }
  }
}

// ---------- viewport / occlusion ----------

type Viewport = {
  /** Bounds of the slim tree's outermost node — what the app currently has rendered into. */
  appBounds?: string;
  /** Full-screen bounds from the raw dump root. */
  screenBounds?: string;
  /** Pixels lost off the bottom (positive = something covers the bottom — usually the soft keyboard). */
  bottomOcclusionPx?: number;
  /** Heuristic: bottomOcclusionPx > 200 (filters out the normal nav bar). */
  likelyOccluded: boolean;
};

const OCCLUSION_THRESHOLD_PX = 200;

function findOutermostBounds(node: SlimNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.bounds) return node.bounds;
  // Pass-through container — descend into first child with bounds.
  for (const c of node.children ?? []) {
    const found = findOutermostBounds(c);
    if (found) return found;
  }
  return undefined;
}

function computeViewport(tree: SlimNode, screenBounds: string | undefined): Viewport {
  const appBounds = findOutermostBounds(tree);
  const screen = parseBounds(screenBounds);
  const app = parseBounds(appBounds);
  if (!screen || !app) return { appBounds, screenBounds, likelyOccluded: false };
  const bottomOcclusionPx = Math.max(0, screen.bottom - app.bottom);
  return {
    appBounds,
    screenBounds,
    bottomOcclusionPx,
    likelyOccluded: bottomOcclusionPx > OCCLUSION_THRESHOLD_PX,
  };
}

function nodeVisibleInViewport(node: SlimNode, viewport: Viewport): boolean | undefined {
  const app = parseBounds(viewport.appBounds);
  const nb = parseBounds(node.bounds);
  if (!app || !nb) return undefined;
  // Visible if the node has any meaningful intersection with the app's current viewport.
  // We require the node's top to be above the viewport bottom (otherwise it's wholly behind the keyboard).
  return nb.top < app.bottom && nb.bottom > app.top;
}

function hasUiMatcher(query: UiQuery): boolean {
  return Boolean(
    query.text !== undefined ||
    query.textContains !== undefined ||
    query.id !== undefined ||
    query.descriptionContains !== undefined ||
    query.type !== undefined ||
    query.clickable !== undefined
  );
}

function nodeClickable(node: SlimNode): boolean {
  return Boolean(node.flags?.includes("click"));
}

function matchesUiNode(node: SlimNode, query: UiQuery): boolean {
  if (query.text !== undefined && node.text !== query.text) return false;
  if (query.textContains !== undefined && !(node.text ?? "").includes(query.textContains)) return false;
  if (query.id !== undefined && node.id !== query.id) return false;
  if (query.descriptionContains !== undefined && !(node.description ?? "").includes(query.descriptionContains)) return false;
  if (query.type !== undefined && node.type !== query.type) return false;
  if (query.clickable !== undefined && nodeClickable(node) !== query.clickable) return false;
  return true;
}

function pickTapNode(node: SlimNode, ancestors: SlimNode[]): SlimNode | null {
  const lineage = [...ancestors, node];
  for (let i = lineage.length - 1; i >= 0; i--) {
    if (nodeClickable(lineage[i]) && lineage[i].bounds) return lineage[i];
  }
  for (let i = lineage.length - 1; i >= 0; i--) {
    if (lineage[i].bounds) return lineage[i];
  }
  return null;
}

function collectUiMatches(
  node: SlimNode,
  query: UiQuery,
  ancestors: SlimNode[] = [],
  path = "0",
  out: UiMatch[] = []
): UiMatch[] {
  if (matchesUiNode(node, query)) {
    const tapNode = pickTapNode(node, ancestors);
    out.push({
      path,
      node,
      center: centerOf(node.bounds),
      tapNode,
      tapCenter: centerOf(tapNode?.bounds),
    });
  }

  for (const [index, child] of (node.children ?? []).entries()) {
    collectUiMatches(child, query, [...ancestors, node], `${path}.${index}`, out);
  }
  return out;
}

function summarizeNode(node: SlimNode): string {
  const parts = [node.type ?? "?"];
  if (node.text) parts.push(`text="${short(node.text, 40)}"`);
  if (node.id) parts.push(`id=${node.id}`);
  if (node.description) parts.push(`desc="${short(node.description, 40)}"`);
  if (node.flags?.length) parts.push(`[${node.flags.join(",")}]`);
  if (node.bounds) parts.push(node.bounds);
  return parts.join(" ");
}

function formatMatchLine(match: UiMatch, index: number, viewport?: Viewport): string {
  const center = match.tapCenter ?? match.center;
  const targetSuffix = match.tapNode && match.tapNode !== match.node
    ? ` -> tap ${summarizeNode(match.tapNode)}`
    : "";
  const coordSuffix = center ? ` @ (${center.x}, ${center.y})` : "";
  const visible = viewport ? nodeVisibleInViewport(match.node, viewport) : undefined;
  const visibleSuffix = visible === false ? " [OCCLUDED]" : "";
  return `[${index}] ${match.path} ${summarizeNode(match.node)}${coordSuffix}${targetSuffix}${visibleSuffix}`;
}

function formatViewportLine(viewport: Viewport): string | undefined {
  if (!viewport.appBounds || !viewport.screenBounds) return undefined;
  if (!viewport.likelyOccluded) return undefined;
  return `Viewport: app=${viewport.appBounds} screen=${viewport.screenBounds} — bottom ${viewport.bottomOcclusionPx}px occluded (likely soft keyboard).`;
}

function describeMatcher(query: UiQuery): string {
  const parts: string[] = [];
  if (query.text !== undefined) parts.push(`text="${query.text}"`);
  if (query.textContains !== undefined) parts.push(`text contains "${query.textContains}"`);
  if (query.id !== undefined) parts.push(`id=${query.id}`);
  if (query.descriptionContains !== undefined) parts.push(`desc contains "${query.descriptionContains}"`);
  if (query.type !== undefined) parts.push(`type=${query.type}`);
  if (query.clickable !== undefined) parts.push(`clickable=${String(query.clickable)}`);
  return parts.join(", ");
}

function short(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleUiDump(args: unknown): Promise<ToolResult> {
  const a = UiDumpArgs.parse(args);
  const loaded = await loadUiTree(a);
  if ("error" in loaded) return errorResult(loaded.error);

  const format = a.format ?? "tree";
  const text = format === "json"
    ? JSON.stringify(loaded.tree, null, 2)
    : renderTree(loaded.tree, 0, { groupSiblings: a.groupSiblings ?? true });
  const header = [
    `UI dump${loaded.bundleFilter ? ` (filter=${loaded.bundleFilter})` : ""} — ${countNodes(loaded.tree)} nodes after slim, raw ${loaded.rawKb} KB`,
    formatViewportLine(loaded.viewport),
  ].filter(Boolean).join("\n");

  return ok(`${header}\n\n${text}`, { tree: loaded.tree, viewport: loaded.viewport });
}

export async function handleFindUi(args: unknown): Promise<ToolResult> {
  const a = FindUiArgs.parse(args);
  const loaded = await loadUiTree(a);
  if ("error" in loaded) return errorResult(loaded.error);

  const limit = a.limit ?? 10;
  const matches = collectUiMatches(loaded.tree, a);
  const shown = matches.slice(0, limit);
  const matcher = describeMatcher(a);
  const viewportLine = formatViewportLine(loaded.viewport);
  const text = matches.length === 0
    ? [
      `No UI nodes matched ${matcher}.${loaded.bundleFilter ? ` bundle=${loaded.bundleFilter}.` : ""}`,
      viewportLine,
    ].filter(Boolean).join("\n")
    : [
      `Found ${matches.length} UI match(es) for ${matcher}.${loaded.bundleFilter ? ` bundle=${loaded.bundleFilter}.` : ""}`,
      viewportLine,
      ...shown.map((match, index) => formatMatchLine(match, index, loaded.viewport)),
      matches.length > shown.length ? `... ${matches.length - shown.length} more omitted.` : undefined,
    ].filter(Boolean).join("\n");

  return ok(text, {
    matcher,
    totalMatches: matches.length,
    viewport: loaded.viewport,
    matches: shown.map((match) => {
      const visible = nodeVisibleInViewport(match.node, loaded.viewport);
      return {
        path: match.path,
        type: match.node.type,
        text: match.node.text,
        id: match.node.id,
        description: match.node.description,
        bounds: match.node.bounds,
        flags: match.node.flags,
        center: match.center ?? undefined,
        tapBounds: match.tapNode?.bounds,
        tapCenter: match.tapCenter ?? undefined,
        visible,
      };
    }),
  });
}

export async function handleTapText(args: unknown): Promise<ToolResult> {
  const a = TapTextArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn. Use emu_start or pass deviceSn.");

  const loaded = await loadUiTree(a);
  if ("error" in loaded) return errorResult(loaded.error);

  const query: UiQuery = a.matchMode === "contains" ? { textContains: a.text } : { text: a.text };
  const matches = collectUiMatches(loaded.tree, query).filter((match) => Boolean(match.tapCenter));
  if (matches.length === 0) {
    const matcher = describeMatcher(query);
    return errorResult(`No tappable UI node matched ${matcher}.${loaded.bundleFilter ? ` bundle=${loaded.bundleFilter}.` : ""}`);
  }

  const index = a.index ?? 0;
  const chosen = matches[index];
  if (!chosen) {
    return errorResult(`tap_text matched ${matches.length} node(s), but index ${index} is out of range.`);
  }

  const target = chosen.tapCenter!;
  const r = await uiInput(sn, ["click", String(target.x), String(target.y)]);
  const summary = formatMatchLine(chosen, index, loaded.viewport);
  const occludedWarning = nodeVisibleInViewport(chosen.node, loaded.viewport) === false
    ? `\n[warning] target appears OCCLUDED — node bottom is below the visible viewport (app=${loaded.viewport.appBounds}). The tap was sent but may have hit the keyboard/overlay instead. Try scrolling the field into view first, or dismiss the keyboard.`
    : "";
  return r.ok
    ? ok(`tap_text "${a.text}" -> (${target.x}, ${target.y})\n${summary}${occludedWarning}`)
    : errorResult(`tap_text failed for "${a.text}":\n${r.out}\n${summary}`);
}

export async function handleWaitForUi(args: unknown): Promise<ToolResult> {
  const a = WaitForUiArgs.parse(args);
  const matcher = describeMatcher(a);
  const condition = a.condition ?? "present";
  const timeoutMs = a.timeoutMs ?? 10000;
  const intervalMs = a.intervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;

  let lastCount = 0;
  let lastShown: UiMatch[] = [];
  let lastViewport: Viewport | undefined;
  let bundleFilter: string | undefined;

  while (true) {
    const loaded = await loadUiTree(a);
    if ("error" in loaded) return errorResult(loaded.error);

    bundleFilter = loaded.bundleFilter;
    lastViewport = loaded.viewport;
    const matches = collectUiMatches(loaded.tree, a);
    lastCount = matches.length;
    lastShown = matches.slice(0, 3);

    const satisfied = condition === "present" ? matches.length > 0 : matches.length === 0;
    if (satisfied) {
      const lines = [
        `wait_for_ui satisfied after ${timeoutMs - Math.max(0, deadline - Date.now())} ms: ${matcher} is ${condition}.`,
        `Current match count: ${matches.length}.`,
        formatViewportLine(loaded.viewport),
      ].filter(Boolean) as string[];
      if (matches.length > 0) lines.push(...lastShown.map((match, index) => formatMatchLine(match, index, loaded.viewport)));
      return ok(lines.join("\n"), {
        matcher,
        condition,
        totalMatches: matches.length,
        viewport: loaded.viewport,
        matches: lastShown.map((match) => ({
          path: match.path,
          text: match.node.text,
          id: match.node.id,
          bounds: match.node.bounds,
          tapCenter: match.tapCenter ?? undefined,
          visible: nodeVisibleInViewport(match.node, loaded.viewport),
        })),
      });
    }

    if (Date.now() >= deadline) break;
    await delay(intervalMs);
  }

  const detail = lastShown.length > 0
    ? `\nLast matches:\n${lastShown.map((match, index) => formatMatchLine(match, index, lastViewport)).join("\n")}`
    : "";
  const viewportLine = lastViewport ? formatViewportLine(lastViewport) : undefined;
  return errorResult(
    `wait_for_ui timed out after ${timeoutMs} ms waiting for ${matcher} to be ${condition}. ` +
    `Last match count: ${lastCount}.${bundleFilter ? ` bundle=${bundleFilter}.` : ""}` +
    (viewportLine ? `\n${viewportLine}` : "") +
    detail
  );
}

function countNodes(n: any): number {
  let c = 1;
  for (const ch of n.children ?? []) c += countNodes(ch);
  return c;
}

// ---------- uiInput primitives ----------

async function uiInput(deviceSn: string, args: string[], timeoutMs = 15000): Promise<{ ok: boolean; out: string }> {
  const r = await hdcShell(deviceSn, ["uitest", "uiInput", ...args], timeoutMs);
  return { ok: r.exitCode === 0, out: `${r.stdout}\n${r.stderr}`.trim() };
}

const PointArgs = z.object({
  x: z.number().int(),
  y: z.number().int(),
  deviceSn: z.string().optional(),
});

export const tapTool = {
  name: "tap",
  description: "Single-tap at (x, y). Use ui_dump to find target bounds; tap the center.",
  inputSchema: zodToJsonSchema(PointArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleTap(args: unknown): Promise<ToolResult> {
  const a = PointArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn.");
  const r = await uiInput(sn, ["click", String(a.x), String(a.y)]);
  return r.ok ? ok(`tap (${a.x}, ${a.y})\n${r.out}`) : errorResult(`tap failed:\n${r.out}`);
}

export const doubleTapTool = {
  name: "double_tap",
  description: "Double-tap at (x, y).",
  inputSchema: zodToJsonSchema(PointArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleDoubleTap(args: unknown): Promise<ToolResult> {
  const a = PointArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn.");
  const r = await uiInput(sn, ["doubleClick", String(a.x), String(a.y)]);
  return r.ok ? ok(`doubleTap (${a.x}, ${a.y})`) : errorResult(`doubleTap failed:\n${r.out}`);
}

export const longPressTool = {
  name: "long_press",
  description: "Long-press at (x, y).",
  inputSchema: zodToJsonSchema(PointArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleLongPress(args: unknown): Promise<ToolResult> {
  const a = PointArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn.");
  const r = await uiInput(sn, ["longClick", String(a.x), String(a.y)]);
  return r.ok ? ok(`longPress (${a.x}, ${a.y})`) : errorResult(`longPress failed:\n${r.out}`);
}

const SwipeArgs = z.object({
  fromX: z.number().int(),
  fromY: z.number().int(),
  toX: z.number().int(),
  toY: z.number().int(),
  velocity: z.number().int().min(200).max(40000).optional().describe("px/s. Default 600."),
  fling: z.boolean().optional().describe("Use fling (inertial). Default false (slow swipe)."),
  drag: z.boolean().optional().describe("Use drag instead of swipe."),
  deviceSn: z.string().optional(),
});

export const swipeTool = {
  name: "swipe",
  description: "Swipe / drag / fling between two points.",
  inputSchema: zodToJsonSchema(SwipeArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleSwipe(args: unknown): Promise<ToolResult> {
  const a = SwipeArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn.");
  const verb = a.drag ? "drag" : a.fling ? "fling" : "swipe";
  const cmd = [verb, String(a.fromX), String(a.fromY), String(a.toX), String(a.toY)];
  if (a.velocity !== undefined) cmd.push(String(a.velocity));
  const r = await uiInput(sn, cmd);
  return r.ok
    ? ok(`${verb} (${a.fromX},${a.fromY}) -> (${a.toX},${a.toY})`)
    : errorResult(`${verb} failed:\n${r.out}`);
}

const DircFlingArgs = z.object({
  direction: z.enum(["left", "right", "up", "down"]),
  velocity: z.number().int().min(200).max(40000).optional(),
  deviceSn: z.string().optional(),
});

export const dircFlingTool = {
  name: "fling_direction",
  description: "Fling in a cardinal direction (left/right/up/down).",
  inputSchema: zodToJsonSchema(DircFlingArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleDircFling(args: unknown): Promise<ToolResult> {
  const a = DircFlingArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn.");
  const dirCode = { left: "0", right: "1", up: "2", down: "3" }[a.direction];
  const cmd = ["dircFling", dirCode];
  if (a.velocity !== undefined) cmd.push(String(a.velocity));
  const r = await uiInput(sn, cmd);
  return r.ok ? ok(`fling ${a.direction}`) : errorResult(`fling failed:\n${r.out}`);
}

const InputTextArgs = z.object({
  x: z.number().int().optional().describe("If omitted, uses 'text' subcommand which targets the focused field."),
  y: z.number().int().optional(),
  text: z.string(),
  deviceSn: z.string().optional(),
});

export const inputTextTool = {
  name: "input_text",
  description:
    "Type text. With (x, y), taps a field then types. Without coords, types into the currently-focused field.",
  inputSchema: zodToJsonSchema(InputTextArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleInputText(args: unknown): Promise<ToolResult> {
  const a = InputTextArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn.");
  const cmd = a.x !== undefined && a.y !== undefined
    ? ["inputText", String(a.x), String(a.y), a.text]
    : ["text", a.text];
  const r = await uiInput(sn, cmd, 30000);
  return r.ok ? ok(`input_text "${a.text}"`) : errorResult(`input_text failed:\n${r.out}`);
}

const KeyEventArgs = z.object({
  keys: z.array(z.union([z.number().int(), z.string()])).min(1).max(3)
    .describe("1-3 keys. Use 'Home' / 'Back' / 'Power' or numeric KeyCodes (e.g. [2072, 2038] for Ctrl+V)."),
  deviceSn: z.string().optional(),
});

export const keyEventTool = {
  name: "key_event",
  description: "Send a hardware key or combination. Examples: ['Home'], ['Back'], [2072, 2038] for Ctrl+V.",
  inputSchema: zodToJsonSchema(KeyEventArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleKeyEvent(args: unknown): Promise<ToolResult> {
  const a = KeyEventArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn.");
  const r = await uiInput(sn, ["keyEvent", ...a.keys.map(String)]);
  return r.ok ? ok(`keyEvent ${a.keys.join("+")}`) : errorResult(`keyEvent failed:\n${r.out}`);
}
