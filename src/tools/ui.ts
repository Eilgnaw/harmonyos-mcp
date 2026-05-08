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
import { slimDump, renderTree } from "../lib/parsers/uiDump.js";

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
  savePath: z.string().optional().describe("If set, also keep a copy at this local path. Saved copy is always the original PNG (no compression)."),
  embedImage: z.boolean().optional().describe("If true (default), include the image as image content. Set false for path-only response."),
  maxDimension: z.number().int().min(64).max(4096).optional().describe("Max width/height for the embedded image, in px. Default 1080. Token cost scales with dimensions, so smaller = cheaper. Set 0 to disable resize."),
  quality: z.number().int().min(1).max(100).optional().describe("JPEG quality for the embedded image (1-100). Default 70."),
  raw: z.boolean().optional().describe("Skip compression and embed the raw PNG. Default false."),
});

export const screenshotTool = {
  name: "screenshot",
  description: "Capture the current screen. Embedded image is downscaled + JPEG-encoded by default (via sharp) to cut token cost while staying readable. Use raw:true for original PNG.",
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

const UiDumpArgs = z.object({
  deviceSn: z.string().optional(),
  bundleFilter: z.string().optional().describe("Restrict to one app by bundle name. Defaults to session.bundleName when set."),
  noBundleFilter: z.boolean().optional().describe("Set true to skip the bundleFilter default and dump everything."),
  onlyInteractive: z.boolean().optional().describe("Drop decorative nodes (default false)."),
  compact: z.boolean().optional().describe("Collapse pass-through containers and empty wrappers (default true). Set false for full structure."),
  groupSiblings: z.boolean().optional().describe("Group ≥3 consecutive same-shape siblings into compact rows showing only their bounds + leaf text (default true)."),
  format: z.enum(["tree", "json"]).optional().describe("Output format. 'tree' (default) is most readable for LLMs."),
});

export const uiDumpTool = {
  name: "ui_dump",
  description:
    "Dump the current control tree (uitest dumpLayout). Slimmed: keeps type/text/id/desc/bounds and " +
    "interactive flags. By default filters to session.bundleName.",
  inputSchema: zodToJsonSchema(UiDumpArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleUiDump(args: unknown): Promise<ToolResult> {
  const a = UiDumpArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn. Use emu_start or pass deviceSn.");

  const bundleFilter = a.noBundleFilter ? undefined : (a.bundleFilter ?? getDefaults().bundleName);

  const remoteName = `mcp_dump_${Date.now()}.json`;
  const remote = deviceTmpPath(remoteName);

  const dump = await hdcShell(
    sn,
    ["uitest", "dumpLayout", "-p", remote, ...(bundleFilter ? ["-b", bundleFilter] : [])],
    20000
  );
  if (dump.exitCode !== 0) {
    return errorResult(`dumpLayout failed (exit ${dump.exitCode}):\n${truncate(dump.stderr || dump.stdout)}`);
  }

  const local = localTmp("dump.json");
  const recv = await hdcFileRecv(sn, remote, local, 30000);
  if (recv.exitCode !== 0) {
    return errorResult(`hdc file recv failed (exit ${recv.exitCode}):\n${truncate(recv.stderr || recv.stdout)}`);
  }
  await hdcShell(sn, ["rm", "-f", remote], 5000).catch(() => undefined);

  const raw = readFileSync(local, "utf8");
  try { unlinkSync(local); } catch { /* best effort */ }

  let slimmed;
  try {
    slimmed = slimDump(raw, {
      bundleFilter,
      onlyInteractive: a.onlyInteractive ?? false,
      compact: a.compact ?? true,
    });
  } catch (e: any) {
    return errorResult(`Failed to parse dump JSON: ${e.message}`);
  }

  const format = a.format ?? "tree";
  const text = format === "json"
    ? JSON.stringify(slimmed, null, 2)
    : renderTree(slimmed, 0, { groupSiblings: a.groupSiblings ?? true });
  const header = `UI dump${bundleFilter ? ` (filter=${bundleFilter})` : ""} — ${countNodes(slimmed)} nodes after slim, raw ${Math.round(raw.length / 1024)} KB`;

  return ok(`${header}\n\n${text}`, { tree: slimmed });
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
