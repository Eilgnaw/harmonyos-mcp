import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ok, errorResult, ToolResult, truncate } from "../lib/result.js";
import { handleBuild } from "./build.js";
import { handleInstall } from "./install.js";
import { handleLaunch } from "./launch.js";
import { handleTapText, handleInputText, handleWaitForUi } from "./ui.js";

const BuildInstallLaunchArgs = z.object({
  projectDir: z.string().optional(),
  module: z.string().optional(),
  product: z.string().optional(),
  buildMode: z.enum(["debug", "release"]).optional(),
  clean: z.boolean().optional(),
  deviceSn: z.string().optional(),
  replace: z.boolean().optional().describe("Pass -r to `hdc install`. Default true."),
  bundleName: z.string().optional(),
  abilityName: z.string().optional(),
  skipInstall: z.boolean().optional().describe("Stop after build."),
  skipLaunch: z.boolean().optional().describe("Stop after install."),
});

export const buildInstallLaunchTool = {
  name: "build_install_launch",
  description:
    "Run build → install → launch in one call, short-circuiting on the first failure. " +
    "Each stage's output is preserved in the response. Most fields default from session — " +
    "typical call after parse_app_meta + emu_start is `{}`. Use skipInstall/skipLaunch to stop early.",
  inputSchema: zodToJsonSchema(BuildInstallLaunchArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleBuildInstallLaunch(args: unknown): Promise<ToolResult> {
  const a = BuildInstallLaunchArgs.parse(args);

  const buildResult = await handleBuild({
    projectDir: a.projectDir,
    module: a.module,
    product: a.product,
    buildMode: a.buildMode,
    clean: a.clean,
  });
  const buildText = textOf(buildResult);
  if (buildResult.isError) {
    return errorResult(
      `[build] FAILED\n\n${buildText}`,
      { stage: "build", success: false }
    );
  }
  const hapPath = (buildResult.structuredContent as any)?.hapPath as string | undefined;
  if (!hapPath) {
    return errorResult(
      `[build] succeeded but no HAP path located — cannot continue.\n\n${buildText}`,
      { stage: "build", success: false }
    );
  }

  if (a.skipInstall) {
    return ok(
      `[build] ok\nHAP: ${hapPath}\n[install] skipped\n[launch] skipped`,
      { stage: "build", hapPath, success: true, skipped: ["install", "launch"] }
    );
  }

  const installResult = await handleInstall({
    hapPath,
    deviceSn: a.deviceSn,
    replace: a.replace,
  });
  const installText = textOf(installResult);
  if (installResult.isError) {
    return errorResult(
      `[build] ok (HAP ${hapPath})\n[install] FAILED\n\n${truncate(installText, 3000)}`,
      { stage: "install", hapPath, success: false }
    );
  }

  if (a.skipLaunch) {
    return ok(
      `[build] ok\n[install] ok\nHAP: ${hapPath}\n[launch] skipped`,
      { stage: "install", hapPath, success: true, skipped: ["launch"] }
    );
  }

  const launchResult = await handleLaunch({
    bundleName: a.bundleName,
    abilityName: a.abilityName,
    module: a.module,
    deviceSn: a.deviceSn,
  });
  const launchText = textOf(launchResult);
  if (launchResult.isError) {
    return errorResult(
      `[build] ok (HAP ${hapPath})\n[install] ok\n[launch] FAILED\n\n${truncate(launchText, 3000)}`,
      { stage: "launch", hapPath, success: false }
    );
  }

  return ok(
    `[build] ok\n[install] ok\n[launch] ok\nHAP: ${hapPath}\n\n${launchText}`,
    { stage: "launch", hapPath, success: true }
  );
}

function textOf(r: ToolResult): string {
  return r.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// ---------- tap_text_and_wait / input_text_and_wait ----------

const UiScopeFields = {
  deviceSn: z.string().optional(),
  bundleFilter: z.string().optional(),
  noBundleFilter: z.boolean().optional(),
  onlyInteractive: z.boolean().optional(),
  compact: z.boolean().optional(),
};

const WaitForBlock = z.object({
  text: z.string().optional(),
  textContains: z.string().optional(),
  id: z.string().optional(),
  descriptionContains: z.string().optional(),
  type: z.string().optional(),
  clickable: z.boolean().optional(),
  condition: z.enum(["present", "absent"]).optional().describe("Default present."),
}).describe(
  "UI matcher to wait for after the action. At least one of " +
  "text/textContains/id/descriptionContains/type/clickable must be set."
);

const TapTextAndWaitArgs = z.object({
  ...UiScopeFields,
  text: z.string().min(1).describe("Text on the node to tap."),
  matchMode: z.enum(["exact", "contains"]).optional(),
  index: z.number().int().min(0).optional(),
  waitFor: WaitForBlock,
  timeoutMs: z.number().int().min(500).max(120000).optional().describe("Wait timeout. Default 10000."),
  intervalMs: z.number().int().min(200).max(5000).optional(),
});

const InputTextAndWaitArgs = z.object({
  ...UiScopeFields,
  x: z.number().int().optional().describe("If omitted, types into the currently-focused field."),
  y: z.number().int().optional(),
  text: z.string().describe("Text to input."),
  waitFor: WaitForBlock,
  timeoutMs: z.number().int().min(500).max(120000).optional(),
  intervalMs: z.number().int().min(200).max(5000).optional(),
});

export const tapTextAndWaitTool = {
  name: "tap_text_and_wait",
  description:
    "Tap a node by text, then wait for a UI condition to be satisfied. " +
    "One call replaces tap_text + screenshot/ui_dump verification — use this whenever the " +
    "next state has a known text/id signature.",
  inputSchema: zodToJsonSchema(TapTextAndWaitArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export const inputTextAndWaitTool = {
  name: "input_text_and_wait",
  description:
    "Type text (optionally targeting (x, y) first), then wait for a UI condition. " +
    "Typical use: type into a search box, wait for results to appear.",
  inputSchema: zodToJsonSchema(InputTextAndWaitArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleTapTextAndWait(args: unknown): Promise<ToolResult> {
  const a = TapTextAndWaitArgs.parse(args);

  const tapResult = await handleTapText({
    deviceSn: a.deviceSn,
    bundleFilter: a.bundleFilter,
    noBundleFilter: a.noBundleFilter,
    onlyInteractive: a.onlyInteractive,
    compact: a.compact,
    text: a.text,
    matchMode: a.matchMode,
    index: a.index,
  });
  if (tapResult.isError) {
    return errorResult(`[tap_text] FAILED\n${truncate(textOf(tapResult), 2000)}`, {
      stage: "tap",
      success: false,
    });
  }

  return runWaitStage(a, tapResult, "tap_text");
}

export async function handleInputTextAndWait(args: unknown): Promise<ToolResult> {
  const a = InputTextAndWaitArgs.parse(args);

  const inputResult = await handleInputText({
    deviceSn: a.deviceSn,
    x: a.x,
    y: a.y,
    text: a.text,
  });
  if (inputResult.isError) {
    return errorResult(`[input_text] FAILED\n${truncate(textOf(inputResult), 2000)}`, {
      stage: "input",
      success: false,
    });
  }

  return runWaitStage(a, inputResult, "input_text");
}

type WaitStageArgs = {
  deviceSn?: string;
  bundleFilter?: string;
  noBundleFilter?: boolean;
  onlyInteractive?: boolean;
  compact?: boolean;
  waitFor: z.infer<typeof WaitForBlock>;
  timeoutMs?: number;
  intervalMs?: number;
};

async function runWaitStage(
  a: WaitStageArgs,
  actionResult: ToolResult,
  actionName: string,
): Promise<ToolResult> {
  const w = a.waitFor;
  if (
    w.text === undefined &&
    w.textContains === undefined &&
    w.id === undefined &&
    w.descriptionContains === undefined &&
    w.type === undefined &&
    w.clickable === undefined
  ) {
    return errorResult(
      `[${actionName}] ok, but waitFor has no matcher fields. ` +
      `Provide at least one of text/textContains/id/descriptionContains/type/clickable.`,
      { stage: "wait", success: false, actionSucceeded: true, reason: "waitFor_no_matcher" }
    );
  }

  const waitResult = await handleWaitForUi({
    deviceSn: a.deviceSn,
    bundleFilter: a.bundleFilter,
    noBundleFilter: a.noBundleFilter,
    onlyInteractive: a.onlyInteractive,
    compact: a.compact,
    text: w.text,
    textContains: w.textContains,
    id: w.id,
    descriptionContains: w.descriptionContains,
    type: w.type,
    clickable: w.clickable,
    condition: w.condition,
    timeoutMs: a.timeoutMs,
    intervalMs: a.intervalMs,
  });

  const actionText = textOf(actionResult);
  const waitText = textOf(waitResult);
  const body = `[${actionName}] ok\n${actionText}\n\n[wait_for_ui] ${waitResult.isError ? "FAILED" : "ok"}\n${waitText}`;

  const structured = {
    stage: waitResult.isError ? "wait" : "done",
    success: !waitResult.isError,
    ...(waitResult.structuredContent ?? {}),
  };

  return waitResult.isError
    ? errorResult(body, structured)
    : ok(body, structured);
}
