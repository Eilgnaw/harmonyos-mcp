# harmonyos-mcp

MCP server for HarmonyOS development. Lets Claude Code (or any MCP client) drive the
DevEco Studio toolchain — emulator lifecycle, build, install, launch, UI inspection
and automation, and live logs — through structured tools.

Wraps:
- `hdc` (device communication, install, hilog, uitest)
- `hvigorw` (project build)
- `Emulator` (DevEco simulator lifecycle)

## Requirements

- Node.js ≥ 18
- DevEco Studio installed (the three CLIs above ship with it)
- macOS or Windows (Linux not supported by DevEco)
- One pre-created emulator instance (in DevEco Device Manager) or a connected device

The server auto-locates the CLIs in this order:
1. `PATH`
2. `DEVECO_STUDIO_HOME` env var
3. Default install paths:
   - macOS: `/Applications/DevEco-Studio.app/Contents`
   - Windows: `%ProgramFiles%\Huawei\DevEco Studio`

It also resolves the HarmonyOS SDK and injects `DEVECO_SDK_HOME` into the
`hvigorw` invocation if the env var isn't already set, checking:
1. `DEVECO_SDK_HOME` env var
2. `<DevEco>/sdk` under any DevEco install root
3. Standalone SDK locations:
   - macOS: `~/Library/Huawei/Sdk`
   - Windows: `%LOCALAPPDATA%\Huawei\Sdk`

If none match, `session_show_defaults` reports the missing tool/sdk with a fix suggestion.

## Install

```bash
npm install -g harmonyos-mcp
```

Or run directly via npx in the MCP config (no global install needed).

## Register with Claude Code

Project-level (`.mcp.json` at the repo root):

```json
{
  "mcpServers": {
    "harmonyos": {
      "command": "npx",
      "args": ["-y", "harmonyos-mcp"]
    }
  }
}
```

Global (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "harmonyos": {
      "command": "npx",
      "args": ["-y", "harmonyos-mcp"]
    }
  }
}
```

If DevEco is installed in a non-standard location, add `"env": { "DEVECO_STUDIO_HOME": "/path/to/Contents" }`.

## Tools

| Tool | Purpose |
|---|---|
| `session_show_defaults` | Show current session + toolchain status. Call this first. |
| `session_set_defaults` | Set `projectDir` / `module` / `bundleName` / `abilityName` / `deviceSn` / `buildMode`. |
| `session_clear_defaults` | Reset everything. |
| `discover_project` | Recursively find HarmonyOS project roots under a directory. |
| `parse_app_meta` | Read `AppScope/app.json5` + `module.json5`, auto-seed session with bundle/module/ability. |
| `emu_list` | List local emulator instances (name, deviceType, osVersion, running). |
| `emu_start` | Launch an emulator and wait for hdc to see it. Auto-sets `deviceSn`. |
| `emu_stop` | Stop a running emulator. |
| `device_list` | `hdc list targets` — see what hdc currently sees. |
| `build` | `hvigorw assembleHap`. Returns parsed errors/warnings + HAP path. |
| `install` | Install a HAP via `hdc install -r`. |
| `launch` | `hdc shell aa start` the configured ability. |
| `screenshot` | Capture screen, return as inline image. |
| `ui_dump` | `uitest dumpLayout` — slimmed control tree (filtered to session bundle by default). |
| `tap` / `double_tap` / `long_press` | UI taps at (x, y). |
| `swipe` | Swipe / drag / fling between two points. |
| `fling_direction` | Cardinal direction fling (left/right/up/down). |
| `input_text` | Type text — at coordinates or into focused field. |
| `key_event` | Hardware keys (`Home`, `Back`, `Power`) or KeyCodes. |
| `logs_dump` | Snapshot the current hilog buffer. |
| `logs_start` / `logs_stop` | Background hilog capture with handle. Auto-cleans after 30 min. |

All build/install/launch/UI tools resolve their args from the session, so after a one-time
`parse_app_meta` + `emu_start`, most calls can be `{}`.

## Typical workflow

```text
session_show_defaults                    → verify toolchain
emu_list                                 → see what's available
emu_start { name: "Pura 80" }            → boots emulator, sets deviceSn
parse_app_meta { projectDir: "..." }     → seeds bundleName/module/abilityName
build {}                                 → returns hapPath
install { hapPath }
launch {}
screenshot {}
ui_dump {}                               → find buttons / text
tap { x, y }                             → drive the UI
logs_dump { level: "E", tail: 100 }      → check for errors
```

## Signing

Emulators run debug-signed HAPs. Make sure your `build-profile.json5` has a
`signingConfigs` entry. DevEco Studio's auto-sign produces one for you. If `build`
succeeds but `install` fails with a signing error, open DevEco → File → Project Structure
→ Signing Configs and let it auto-generate.

## Capabilities (env)

UI input and logs streaming are always on. There's no capability gating yet — if you
need to disable destructive tools, fork and remove them from `src/tools/index.ts`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Could not locate 'hdc'` | DevEco not installed, or `DEVECO_STUDIO_HOME` wrong. |
| `build` fails with `00303217 Configuration Error: Invalid value of 'DEVECO_SDK_HOME'` | SDK not auto-detected. Set `DEVECO_SDK_HOME` in the MCP server's `env` block to your SDK root (e.g. `~/Library/Huawei/Sdk` or `<DevEco>/Contents/sdk`). |
| `emu_start` says emulator didn't appear in hdc | First boot can exceed 60 s. Re-run with `waitForHdcMs: 120000`, or check DevEco Device Manager. |
| `install` fails with signing error | See Signing above. |
| `ui_dump` returns "Group" with everything inside | Filter mismatch — your bundle isn't in front. Pass `noBundleFilter: true` or set `bundleName` correctly. |
| `logs_*` returns nothing | Filter too narrow, or no device connected. Try `logs_dump { tail: 50 }` with no filters first. |

## Development

```bash
npm install
npm run build
npm run dev          # tsx watch mode (for the smoke runner / direct invocation)
```

Direct tool testing without an MCP client:
```bash
npx tsx src/__smoke__.ts ui     # tries ui_dump + screenshot
npx tsx src/__smoke__.ts logs   # tries logs_dump + start/stop
```

## License

MIT
