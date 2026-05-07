import { ToolResult, errorResult } from "../lib/result.js";
import {
  sessionShowTool, handleSessionShow,
  sessionSetTool, handleSessionSet,
  sessionClearTool, handleSessionClear,
} from "./session.js";
import {
  emuListTool, handleEmuList,
  emuStartTool, handleEmuStart,
  emuStopTool, handleEmuStop,
} from "./emulator.js";
import { deviceListTool, handleDeviceList } from "./device.js";
import {
  discoverProjectTool, handleDiscoverProject,
  parseAppMetaTool, handleParseAppMeta,
} from "./project.js";
import { buildTool, handleBuild } from "./build.js";
import { installTool, handleInstall } from "./install.js";
import { launchTool, handleLaunch } from "./launch.js";
import {
  screenshotTool, handleScreenshot,
  uiDumpTool, handleUiDump,
  tapTool, handleTap,
  doubleTapTool, handleDoubleTap,
  longPressTool, handleLongPress,
  swipeTool, handleSwipe,
  dircFlingTool, handleDircFling,
  inputTextTool, handleInputText,
  keyEventTool, handleKeyEvent,
} from "./ui.js";
import {
  logsDumpTool, handleLogsDump,
  logsStartTool, handleLogsStart,
  logsStopTool, handleLogsStop,
} from "./logs.js";

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type Entry = {
  def: ToolDef;
  handler: (args: unknown) => Promise<ToolResult>;
};

const registry: Record<string, Entry> = {
  [sessionShowTool.name]: { def: sessionShowTool, handler: handleSessionShow },
  [sessionSetTool.name]: { def: sessionSetTool, handler: handleSessionSet },
  [sessionClearTool.name]: { def: sessionClearTool, handler: handleSessionClear },
  [emuListTool.name]: { def: emuListTool, handler: handleEmuList },
  [emuStartTool.name]: { def: emuStartTool, handler: handleEmuStart },
  [emuStopTool.name]: { def: emuStopTool, handler: handleEmuStop },
  [deviceListTool.name]: { def: deviceListTool, handler: handleDeviceList },
  [discoverProjectTool.name]: { def: discoverProjectTool, handler: handleDiscoverProject },
  [parseAppMetaTool.name]: { def: parseAppMetaTool, handler: handleParseAppMeta },
  [buildTool.name]: { def: buildTool, handler: handleBuild },
  [installTool.name]: { def: installTool, handler: handleInstall },
  [launchTool.name]: { def: launchTool, handler: handleLaunch },
  [screenshotTool.name]: { def: screenshotTool, handler: handleScreenshot },
  [uiDumpTool.name]: { def: uiDumpTool, handler: handleUiDump },
  [tapTool.name]: { def: tapTool, handler: handleTap },
  [doubleTapTool.name]: { def: doubleTapTool, handler: handleDoubleTap },
  [longPressTool.name]: { def: longPressTool, handler: handleLongPress },
  [swipeTool.name]: { def: swipeTool, handler: handleSwipe },
  [dircFlingTool.name]: { def: dircFlingTool, handler: handleDircFling },
  [inputTextTool.name]: { def: inputTextTool, handler: handleInputText },
  [keyEventTool.name]: { def: keyEventTool, handler: handleKeyEvent },
  [logsDumpTool.name]: { def: logsDumpTool, handler: handleLogsDump },
  [logsStartTool.name]: { def: logsStartTool, handler: handleLogsStart },
  [logsStopTool.name]: { def: logsStopTool, handler: handleLogsStop },
};

export function allTools(): ToolDef[] {
  return Object.values(registry).map((e) => e.def);
}

export async function callTool(name: string, args: unknown): Promise<ToolResult> {
  const entry = registry[name];
  if (!entry) return errorResult(`Unknown tool: ${name}`);
  try {
    return await entry.handler(args);
  } catch (e: any) {
    if (e?.name === "ZodError") {
      return errorResult(`Invalid arguments for ${name}:\n${JSON.stringify(e.issues, null, 2)}`);
    }
    return errorResult(`Tool '${name}' threw: ${e?.message ?? String(e)}`);
  }
}
