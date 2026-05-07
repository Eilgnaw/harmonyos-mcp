// Local smoke test runner: invokes tool handlers directly without MCP transport.
// Run with: npx tsx src/__smoke__.ts <step>
import { callTool } from "./tools/index.js";

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  console.log(`\n>>> ${name} ${JSON.stringify(args)}`);
  const r = await callTool(name, args);
  console.log(`isError: ${r.isError ?? false}`);
  for (const c of r.content) if (c.type === "text") console.log(c.text);
  return r;
}

function pct(base: string, sub: string): string {
  const r = 100 * (1 - sub.length / base.length);
  return `-${r.toFixed(1)}%`;
}

async function main(): Promise<void> {
  const step = process.argv[2] ?? "all";

  if (step === "show" || step === "all") await call("session_show_defaults");
  if (step === "list" || step === "all") await call("emu_list");
  if (step === "devices" || step === "all") await call("device_list");
  if (step === "start") await call("emu_start", { name: "Pura 80", waitForHdcMs: 90000 });
  if (step === "stop") await call("emu_stop", { name: "Pura 80" });

  if (step === "project") {
    await call("discover_project", { rootDir: "/Users/wxl/Documents/AWidget_harmony" });
    await call("parse_app_meta", { projectDir: "/Users/wxl/Documents/AWidget_harmony" });
    await call("session_show_defaults");
  }

  if (step === "logs") {
    await call("session_set_defaults", { deviceSn: "127.0.0.1:5555" });
    await call("logs_dump", { tail: 5 });
    const start = await call("logs_start", { tag: "Ace" });
    const handle = start?.structuredContent?.handle;
    console.log(`\n>>> sleeping 3s while logs accumulate...`);
    await new Promise((r) => setTimeout(r, 3000));
    await call("logs_stop", { handle, tail: 10 });
  }

  if (step === "ui") {
    await call("session_set_defaults", {
      projectDir: "/Users/wxl/Documents/AWidget_harmony",
      bundleName: "com.eilgnaw.AwidgteH",
      module: "entry",
      abilityName: "EntryAbility",
      deviceSn: "127.0.0.1:5555",
    });
    await call("ui_dump", { onlyInteractive: true });
    await call("screenshot", { embedImage: false, savePath: "/tmp/mcp_screen_test.png" });
  }

  if (step === "compact-compare") {
    await call("session_set_defaults", { deviceSn: "127.0.0.1:5555", bundleName: "com.eilgnaw.AwidgteH" });
    const r1 = await call("ui_dump", { compact: false, groupSiblings: false });
    const r2 = await call("ui_dump", { compact: true, groupSiblings: false });
    const r3 = await call("ui_dump", { compact: true, groupSiblings: true });
    const t1 = r1.content[0].text;
    const t2 = r2.content[0].text;
    const t3 = r3.content[0].text;
    console.log(`\n=== compression summary ===`);
    console.log(`baseline (no compression):       ${t1.length} chars`);
    console.log(`+ container collapse:            ${t2.length} chars  (${pct(t1, t2)})`);
    console.log(`+ container collapse + grouping: ${t3.length} chars  (${pct(t1, t3)})`);
  }

  if (step === "fullchain") {
    await call("parse_app_meta", { projectDir: "/Users/wxl/Documents/AWidget_harmony" });
    await call("session_set_defaults", { deviceSn: "127.0.0.1:5555" });
    const buildRes = await call("build", {});
    const hapPath = buildRes?.structuredContent?.hapPath;
    if (!hapPath) {
      console.log("No hapPath returned, aborting.");
      return;
    }
    await call("install", { hapPath });
    await call("launch", {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
