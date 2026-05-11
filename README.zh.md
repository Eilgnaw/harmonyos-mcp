# harmonyos-mcp

> 中文 · [English README](./README.md)

面向 HarmonyOS 开发的 MCP 服务。让 Claude Code（或任何 MCP 客户端）通过结构化工具驱动
DevEco Studio 工具链 —— 模拟器生命周期、构建、安装、启动、UI 检查与自动化、实时日志。

封装：
- `hdc`（设备通信、安装、hilog、uitest）
- `hvigorw`（工程构建）
- `Emulator`（DevEco 模拟器生命周期）

## 环境要求

- Node.js ≥ 18
- 已安装 DevEco Studio（上述三个 CLI 随其分发）
- macOS 或 Windows（DevEco 不支持 Linux）
- 一个已创建的模拟器实例（在 DevEco Device Manager 中）或一台已连接的真机

服务按以下顺序自动定位 CLI：
1. `PATH`
2. `DEVECO_STUDIO_HOME` 环境变量
3. 默认安装路径：
   - macOS: `/Applications/DevEco-Studio.app/Contents`
   - Windows: `%ProgramFiles%\Huawei\DevEco Studio`

如果环境变量未设置，服务还会自动定位 HarmonyOS SDK 并把 `DEVECO_SDK_HOME` 注入到
`hvigorw` 调用，查找顺序：
1. `DEVECO_SDK_HOME` 环境变量
2. 任意 DevEco 安装根下的 `<DevEco>/sdk`
3. 独立 SDK 位置：
   - macOS: `~/Library/Huawei/Sdk`
   - Windows: `%LOCALAPPDATA%\Huawei\Sdk`

如果都未命中，`session_show_defaults` 会指出缺失的工具/SDK 并给出修复建议。

## 安装

```bash
npm install -g harmonyos-mcp
```

或者直接在 MCP 配置里用 npx 调用，不需要全局安装。

## 在 Claude Code 中注册

项目级（仓库根目录的 `.mcp.json`）：

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

全局级（`~/Library/Application Support/Claude/claude_desktop_config.json`）：

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

如果 DevEco 装在非标准位置，加 `"env": { "DEVECO_STUDIO_HOME": "/path/to/Contents" }`。

## 工具

| 工具 | 作用 |
|---|---|
| `session_show_defaults` | 显示当前 session 默认值 + 工具链状态。先调这个。 |
| `session_set_defaults` | 设置 `projectDir` / `module` / `bundleName` / `abilityName` / `deviceSn` / `buildMode`。 |
| `session_clear_defaults` | 清空所有默认值。 |
| `discover_project` | 在某个目录下递归查找 HarmonyOS 工程根。 |
| `parse_app_meta` | 读取 `AppScope/app.json5` + `module.json5`，自动把 bundle/module/ability 写入 session。 |
| `emu_list` | 列出本机模拟器实例（name / deviceType / osVersion / running）。 |
| `emu_start` | 启动一个模拟器并等待 hdc 看到它。自动设置 `deviceSn`。 |
| `emu_stop` | 停止一个运行中的模拟器。 |
| `device_list` | `hdc list targets` —— 看 hdc 当前能看到哪些设备。 |
| `app_state` | 通过 `aa dump -l` 报告设备前台应用 —— bundle / ability / module / pid。做分支判断时比 `screenshot` 便宜得多。 |
| `build` | `hvigorw assembleHap`。返回解析后的错误/警告 + HAP 路径。 |
| `install` | 通过 `hdc install -r` 安装 HAP。 |
| `launch` | `hdc shell aa start` 启动配置好的 ability。 |
| `build_install_launch` | 一键 build → install → launch，遇第一个失败立刻短路。 |
| `screenshot` | 截屏，返回内联图片。**用得越少越好** —— 大多数"想问的问题"用文本工具更便宜。 |
| `ui_dump` | `uitest dumpLayout` —— 精简后的控件树（默认按 session bundle 过滤）。head 标注 viewport 边界，并在疑似软键盘遮挡时标注。 |
| `find_ui` | 用 `text` / `textContains` / `id` / `descriptionContains` / `type` / `clickable` 查询 UI 树。只返回命中节点 + tap 中心点，不带整棵树。每个 match 带 `visible` 标记，结果里附带 `viewport { appBounds, screenBounds, bottomOcclusionPx, likelyOccluded }`，能判断目标是否被软键盘遮住。 |
| `tap_text` | 按文字找节点并点击（找不到 click 标志时自动回溯到最近的可点击祖先）。支持 `exact` / `contains` 和 `index` 选多匹配。 |
| `tap_text_and_wait` | 按文字点击 **然后** 等一个 UI 条件成立 —— 一次调用替代 tap + screenshot/ui_dump 验证。 |
| `input_text_and_wait` | 输入文本 **然后** 等一个 UI 条件（比如在搜索框输入后等结果出现）。 |
| `wait_for_ui` | 轮询 UI 树，直到匹配出现或消失（`condition: present` / `absent`）。用于导航/加载完成判断。 |
| `tap` / `double_tap` / `long_press` | 在 (x, y) 点击 / 双击 / 长按。 |
| `swipe` | 两点之间滑动 / 拖拽 / 惯性滑动。 |
| `fling_direction` | 朝某个方向惯性滑动（left/right/up/down）。 |
| `input_text` | 输入文本 —— 可指定坐标或写入当前 focus 字段。 |
| `key_event` | 硬件按键（`Home` / `Back` / `Power`）或 KeyCode 组合。 |
| `logs_dump` | 一次性快照 hilog 缓冲。 |
| `logs_start` / `logs_stop` | 后台抓 hilog，拿 handle 操作。30 分钟空闲自动清理。 |
| `wait_for_log` | 流式监听 hilog，直到正则匹配到（或超时）。命中返回匹配行 + 前若干行上下文。 |
| `pull_file` | 通过 `hdc file recv` 把设备文件拉回主机 —— sqlite、沙箱配置、崩溃 dump 等。 |

所有 build/install/launch/UI 工具都从 session 取参数，所以执行一次 `parse_app_meta` + `emu_start` 后，
大多数调用可以传 `{}`。

## 典型工作流

```text
session_show_defaults                              → 校验工具链
emu_list                                           → 看本机有哪些模拟器
emu_start { name: "Pura 80" }                      → 启动模拟器并写入 deviceSn
parse_app_meta { projectDir: "..." }               → 写入 bundleName/module/abilityName
build_install_launch {}                            → build → install → launch 一次到位
wait_for_log { pattern: "Displayed" }              → 阻塞直到应用渲染上屏
app_state {}                                       → 确认前台 bundle
tap_text_and_wait {                                → tap + 验证 一次完成（省掉一次截图）
  text: "登录",
  waitFor: { textContains: "首页" },
}
logs_dump { level: "E", tail: 100 }                → 检查报错
pull_file { remotePath: "...", localPath: "..." }  → 拿 sqlite / 崩溃 dump
```

如果需要更细的控制，底层工具（`build`、`install`、`launch`、`ui_dump`、`find_ui`、`tap`…）依然可用。

## 签名

模拟器只接受 debug 签名的 HAP。确认你的 `build-profile.json5` 里有 `signingConfigs` 一项 ——
DevEco Studio 的自动签名会生成。如果 `build` 成功但 `install` 报签名错，去
DevEco → File → Project Structure → Signing Configs 让它自动生成。

## 权限控制（env）

UI 输入和日志流目前默认全开，还没有 capability 闸门 —— 如果需要禁用某些破坏性工具，
fork 后从 `src/tools/index.ts` 删掉对应项。

## 故障排查

| 现象 | 可能原因 |
|---|---|
| `Could not locate 'hdc'` | DevEco 没装，或 `DEVECO_STUDIO_HOME` 不对。 |
| `build` 报 `00303217 Configuration Error: Invalid value of 'DEVECO_SDK_HOME'` | SDK 没被自动定位。在 MCP server 的 `env` 块里写 `DEVECO_SDK_HOME` 指向 SDK 根（如 `~/Library/Huawei/Sdk` 或 `<DevEco>/Contents/sdk`）。 |
| `emu_start` 报模拟器没出现在 hdc 里 | 首次冷启动可能超过 60s。重试时传 `waitForHdcMs: 120000`，或在 DevEco Device Manager 检查状态。 |
| `install` 报签名错 | 看上面"签名"。 |
| `ui_dump` 返回的 "Group" 把所有东西套进去 | 过滤不匹配 —— 你的 bundle 不在前台。传 `noBundleFilter: true`，或正确设置 `bundleName`。用 `app_state {}` 确认。 |
| `logs_*` 没返回任何东西 | 过滤太窄，或设备没连。先用 `logs_dump { tail: 50 }` 不带过滤试。 |
| `tap_text` 说没匹配节点 | 文字可能在图片里、是自绘组件，或在键盘下方（uitest 会把完全位于软键盘之下的节点裁掉）。检查 `find_ui` 输出里的 viewport 遮挡 banner，然后关闭键盘或滚动后再试。 |
| `tap_text` 返回 `[warning] target appears OCCLUDED` | 命中节点的 bounds 超过可见 viewport 底部 —— 通常是软键盘弹起。先关闭（如 `key_event { keys: ["Back"] }`）或滚动把字段拉进视野再重试。 |
| `wait_for_log` 超时但 `logs_dump` 能看到那行 | `wait_for_log` 的过滤太窄 —— 先去掉 `tag`/`level`，只留 `pattern` 试。 |
| `app_state` 返回 `foreground: null` | 输出格式因 HarmonyOS 版本不同。响应里附带了原始输出 —— 提 issue 把那段贴出来，我会扩展 parser。 |

## 开发

```bash
npm install
npm run build
npm run dev          # tsx watch（用于直接 invoke 或 smoke runner）
```

不经过 MCP 客户端直接测试工具：
```bash
npx tsx src/__smoke__.ts ui     # 测 ui_dump + screenshot
npx tsx src/__smoke__.ts logs   # 测 logs_dump + start/stop
```

## 链接

- **[Linux.do](https://linux.do)**

## License

MIT
