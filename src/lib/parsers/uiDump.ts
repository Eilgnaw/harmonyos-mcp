// Compressor for `uitest dumpLayout` output.
// Raw dumps are 50-200KB with verbose visual attributes; we slim them aggressively.

const KEEP_ATTRS = [
  "type", "text", "id", "key", "description",
  "bundleName", "abilityName",
  "clickable", "checkable", "checked", "selected",
  "scrollable", "longClickable", "enabled", "focused",
  "bounds",
];

export type SlimNode = {
  type?: string;
  text?: string;
  id?: string;
  key?: string;
  description?: string;
  bundleName?: string;
  abilityName?: string;
  bounds?: string;
  flags?: string[];
  children?: SlimNode[];
};

const FLAG_ATTRS: Record<string, string> = {
  clickable: "click",
  checkable: "checkable",
  checked: "checked",
  selected: "selected",
  scrollable: "scroll",
  longClickable: "longClick",
  focused: "focused",
};

export type SlimOptions = {
  bundleFilter?: string;
  onlyInteractive?: boolean;
  includeBounds?: boolean;
  compact?: boolean;
};

export type SlimDumpResult = {
  tree: SlimNode;
  /** Bounds of the outermost raw node (always full screen, even when the filtered tree shrinks under keyboard occlusion). */
  screenBounds?: string;
};

export function slimDump(rawJsonText: string, opts: SlimOptions = {}): SlimDumpResult {
  const root = JSON.parse(rawJsonText);
  const screenBounds = (root?.attributes?.bounds as string | undefined) ?? undefined;
  const bundleFilter = opts.bundleFilter;
  const onlyInteractive = opts.onlyInteractive ?? false;
  const includeBounds = opts.includeBounds ?? true;
  const compact = opts.compact ?? true;
  let slimmed = walk(root, { bundleFilter, onlyInteractive, includeBounds });
  if (slimmed && compact) slimmed = compactTree(slimmed);
  return { tree: slimmed ?? { type: "(empty)" }, screenBounds };
}

function nodeHasSemantics(n: SlimNode): boolean {
  return Boolean(n.text || n.id || n.key || n.description || (n.flags && n.flags.length > 0));
}

function boundsContains(outer?: string, inner?: string): boolean {
  if (!outer || !inner) return true;
  const o = parseBounds(outer);
  const i = parseBounds(inner);
  if (!o || !i) return true;
  return i.left >= o.left && i.top >= o.top && i.right <= o.right && i.bottom <= o.bottom;
}

// Drop pass-through containers (single child, no semantics, bounds-contained)
// and empty leaves. Operates bottom-up so collapses cascade.
function compactTree(node: SlimNode): SlimNode {
  if (node.children) {
    const compacted: SlimNode[] = [];
    for (const c of node.children) {
      const cc = compactTree(c);
      if (isEmptyLeaf(cc)) continue;
      compacted.push(cc);
    }
    if (compacted.length === 0) delete node.children;
    else node.children = compacted;
  }

  if (
    node.children &&
    node.children.length === 1 &&
    !nodeHasSemantics(node) &&
    boundsContains(node.bounds, node.children[0].bounds)
  ) {
    return node.children[0];
  }

  return node;
}

function isEmptyLeaf(n: SlimNode): boolean {
  if (n.children && n.children.length > 0) return false;
  if (nodeHasSemantics(n)) return false;
  // Untyped or anonymous container with no semantics and no children — useless.
  return !n.type || n.type === "Group" || n.type === "Stack" || n.type === "Column" || n.type === "Row" || n.type === "__Common__";
}

function walk(node: any, opts: { bundleFilter?: string; onlyInteractive: boolean; includeBounds: boolean }): SlimNode | null {
  const attrs = node?.attributes ?? {};
  const children = Array.isArray(node?.children) ? node.children : [];

  const slimmedChildren: SlimNode[] = [];
  for (const c of children) {
    const sc = walk(c, opts);
    if (sc) slimmedChildren.push(sc);
  }

  if (opts.bundleFilter) {
    const nodeBundle = attrs.bundleName;
    const isRoot = !attrs.type || attrs.type === "";
    if (!isRoot && nodeBundle && nodeBundle !== opts.bundleFilter) {
      // Drop nodes from other apps; keep their interesting children that match.
      if (slimmedChildren.length === 0) return null;
      if (slimmedChildren.length === 1) return slimmedChildren[0];
      return { type: "Group", children: slimmedChildren };
    }
  }

  const out: SlimNode = {};
  if (attrs.type) out.type = attrs.type;
  if (attrs.text) out.text = attrs.text;
  if (attrs.id) out.id = attrs.id;
  if (attrs.key) out.key = attrs.key;
  if (attrs.description) out.description = attrs.description;
  if (attrs.bundleName && !opts.bundleFilter) out.bundleName = attrs.bundleName;
  if (attrs.abilityName) out.abilityName = attrs.abilityName;
  if (opts.includeBounds && attrs.bounds) out.bounds = attrs.bounds;

  const flags: string[] = [];
  for (const [attr, label] of Object.entries(FLAG_ATTRS)) {
    if (attrs[attr] === "true" || attrs[attr] === true) flags.push(label);
  }
  if (flags.length > 0) out.flags = flags;

  if (slimmedChildren.length > 0) out.children = slimmedChildren;

  if (opts.onlyInteractive) {
    const isInteractive = flags.length > 0 || !!out.text || !!out.description || !!out.id;
    const hasInteractiveChildren = (out.children ?? []).length > 0;
    if (!isInteractive && !hasInteractiveChildren) return null;
  }

  if (Object.keys(out).length === 0) return null;
  return out;
}

export type RenderOptions = {
  groupSiblings?: boolean;
  groupMinRun?: number;
};

export function renderTree(node: SlimNode, indent = 0, opts: RenderOptions = {}): string {
  const groupSiblings = opts.groupSiblings ?? true;
  const groupMinRun = opts.groupMinRun ?? 3;
  const pad = "  ".repeat(indent);
  const lines = [`${pad}${renderHeader(node)}`];

  if (!node.children || node.children.length === 0) return lines.join("\n");

  const runs = groupSiblings ? groupRunsByShape(node.children) : node.children.map((c) => [c]);
  for (const run of runs) {
    if (run.length >= groupMinRun) {
      lines.push(renderRun(run, indent + 1));
    } else {
      for (const c of run) lines.push(renderTree(c, indent + 1, opts));
    }
  }
  return lines.join("\n");
}

function renderHeader(n: SlimNode): string {
  const parts: string[] = [n.type ?? "?"];
  if (n.text) parts.push(`text="${truncate(n.text, 40)}"`);
  if (n.id) parts.push(`id=${n.id}`);
  if (n.key) parts.push(`key=${n.key}`);
  if (n.description) parts.push(`desc="${truncate(n.description, 40)}"`);
  if (n.flags && n.flags.length) parts.push(`[${n.flags.join(",")}]`);
  if (n.bounds) parts.push(n.bounds);
  return parts.join(" ");
}

function shapeSig(n: SlimNode): string {
  const flags = n.flags ? `{${n.flags.slice().sort().join(",")}}` : "";
  const kids = (n.children ?? []).map(shapeSig).join("|");
  return `${n.type ?? "?"}${flags}[${kids}]`;
}

function groupRunsByShape(children: SlimNode[]): SlimNode[][] {
  const runs: SlimNode[][] = [];
  let current: SlimNode[] = [];
  let currentSig = "";
  for (const c of children) {
    const sig = shapeSig(c);
    if (sig === currentSig) {
      current.push(c);
    } else {
      if (current.length) runs.push(current);
      current = [c];
      currentSig = sig;
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

function renderRun(run: SlimNode[], indent: number): string {
  const pad = "  ".repeat(indent);
  const head = run[0];
  const flagPart = head.flags?.length ? ` [${head.flags.join(",")}]` : "";
  const shape = shapeSummary(head);
  const lines = [`${pad}${head.type ?? "?"}${flagPart} ×${run.length}${shape ? ` each={${shape}}` : ""}`];
  for (const inst of run) {
    const leaves = collectLeafTexts(inst);
    const summary = leaves.length ? `  ${leaves.map((s) => `"${s}"`).join(" / ")}` : "";
    lines.push(`${pad}  ${inst.bounds ?? ""}${summary}`);
  }
  return lines.join("\n");
}

function shapeSummary(n: SlimNode): string {
  if (!n.children || n.children.length === 0) return "";
  return n.children.map((c) => {
    const inner = shapeSummary(c);
    return inner ? `${c.type ?? "?"}[${inner}]` : (c.type ?? "?");
  }).join("+");
}

function collectLeafTexts(n: SlimNode, out: string[] = []): string[] {
  if (n.text) out.push(truncate(n.text, 40));
  for (const c of n.children ?? []) collectLeafTexts(c, out);
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

export function parseBounds(b?: string): { left: number; top: number; right: number; bottom: number } | null {
  if (!b) return null;
  const m = b.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  return { left: +m[1], top: +m[2], right: +m[3], bottom: +m[4] };
}

export function centerOf(bounds?: string): { x: number; y: number } | null {
  const b = parseBounds(bounds);
  if (!b) return null;
  return { x: Math.floor((b.left + b.right) / 2), y: Math.floor((b.top + b.bottom) / 2) };
}
