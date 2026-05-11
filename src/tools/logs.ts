import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { randomUUID } from "node:crypto";
import { ChildProcess, spawn } from "node:child_process";
import { run, spawnBackground } from "../lib/exec.js";
import { hdcPath } from "../lib/hdc.js";
import { ok, errorResult, ToolResult, truncate } from "../lib/result.js";
import { getDefaults } from "../lib/session.js";

type Session = {
  proc: ChildProcess;
  stdoutBuffer: string[];
  stderrBuffer: string[];
  startedAt: number;
  deviceSn: string;
  filters: Record<string, unknown>;
  ttlTimer?: NodeJS.Timeout;
};

const sessions = new Map<string, Session>();
const TTL_MS = 30 * 60 * 1000;

const FilterFields = z.object({
  tag: z.string().optional(),
  domain: z.string().optional(),
  level: z.enum(["D", "I", "W", "E", "F"]).optional(),
  pid: z.number().int().optional(),
  regex: z.string().optional(),
});

function buildHilogArgs(deviceSn: string, filters: z.infer<typeof FilterFields>, oneshot: boolean): string[] {
  const args = ["-t", deviceSn, "hilog"];
  if (oneshot) args.push("-x");
  if (filters.tag) args.push("-T", filters.tag);
  if (filters.domain) args.push("-D", filters.domain);
  if (filters.level) args.push("-L", filters.level);
  if (filters.pid !== undefined) args.push("-P", String(filters.pid));
  if (filters.regex) args.push("-e", filters.regex);
  return args;
}

function sessionDevice(explicit?: string): string | null {
  return explicit ?? getDefaults().deviceSn ?? null;
}

// ---------- logs_dump ----------

const DumpArgs = FilterFields.extend({
  deviceSn: z.string().optional(),
  tail: z.number().int().min(1).max(10000).optional().describe("Show last N lines from buffer. Default 200."),
});

export const logsDumpTool = {
  name: "logs_dump",
  description:
    "One-shot snapshot of the device hilog buffer. For continuous capture use logs_start/logs_stop.",
  inputSchema: zodToJsonSchema(DumpArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleLogsDump(args: unknown): Promise<ToolResult> {
  const a = DumpArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn.");
  const tail = a.tail ?? 200;
  const cmdArgs = buildHilogArgs(sn, a, true);
  const r = await run(hdcPath(), cmdArgs, { timeoutMs: 60000 });
  const stdoutText = r.stdout;
  const noData = !stdoutText.trim();
  if (noData && r.exitCode !== 0) {
    return errorResult(`hilog failed (exit ${r.exitCode}, timedOut=${r.timedOut}):\n${truncate(r.stderr)}`);
  }
  let lines = stdoutText.split("\n");
  if (lines.length > tail) lines = lines.slice(-tail);
  const out = lines.join("\n").trim();
  const note = r.timedOut ? "\n\n[note: hilog stream truncated by 60s timeout]" : "";
  return ok((out || "(no log lines matched)") + note, { lines: lines.length, timedOut: r.timedOut });
}

// ---------- logs_start ----------

const StartArgs = FilterFields.extend({
  deviceSn: z.string().optional(),
});

export const logsStartTool = {
  name: "logs_start",
  description:
    "Start streaming hilog in the background. Returns a handle; call logs_stop to retrieve buffered output. " +
    "Auto-cleaned after 30 min idle.",
  inputSchema: zodToJsonSchema(StartArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleLogsStart(args: unknown): Promise<ToolResult> {
  const a = StartArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn.");

  const handle = `log-${randomUUID().slice(0, 8)}`;
  const cmdArgs = buildHilogArgs(sn, a, false);
  const bg = spawnBackground(hdcPath(), cmdArgs);

  const ttl = setTimeout(() => stopSession(handle, "ttl"), TTL_MS);
  ttl.unref?.();

  const session: Session = {
    proc: bg.proc,
    stdoutBuffer: bg.stdoutBuffer,
    stderrBuffer: bg.stderrBuffer,
    startedAt: bg.startedAt,
    deviceSn: sn,
    filters: a,
    ttlTimer: ttl,
  };
  sessions.set(handle, session);

  bg.proc.on("exit", () => {
    // Keep the buffer for collection by logs_stop; just clear the TTL.
    if (session.ttlTimer) clearTimeout(session.ttlTimer);
  });

  return ok(`Logs streaming. handle=${handle}\nFilters: ${JSON.stringify(a)}`, { handle });
}

// ---------- logs_stop ----------

const StopArgs = z.object({
  handle: z.string(),
  grep: z.string().optional().describe("Optional regex to filter the captured output before returning."),
  tail: z.number().int().min(1).max(5000).optional().describe("Limit to last N lines. Default 500."),
});

export const logsStopTool = {
  name: "logs_stop",
  description:
    "Stop a logs_start session and return its captured output (filtered, tail-limited).",
  inputSchema: zodToJsonSchema(StopArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleLogsStop(args: unknown): Promise<ToolResult> {
  const a = StopArgs.parse(args);
  const session = sessions.get(a.handle);
  if (!session) return errorResult(`Unknown handle: ${a.handle}`);

  stopSession(a.handle, "user");

  let lines = session.stdoutBuffer.join("").split("\n");
  if (a.grep) {
    try {
      const re = new RegExp(a.grep);
      lines = lines.filter((l) => re.test(l));
    } catch (e: any) {
      return errorResult(`Invalid grep regex: ${e.message}`);
    }
  }
  const tail = a.tail ?? 500;
  if (lines.length > tail) lines = lines.slice(-tail);
  const text = lines.join("\n").trim();

  const stderr = session.stderrBuffer.join("").trim();
  const elapsedMs = Date.now() - session.startedAt;

  const header = `Captured ${lines.length} line(s) over ${(elapsedMs / 1000).toFixed(1)}s${a.grep ? ` (grep=${a.grep})` : ""}`;
  const body = text || "(empty)";
  return ok(`${header}\n\n${body}${stderr ? `\n\n[stderr]\n${truncate(stderr, 1000)}` : ""}`);
}

// ---------- wait_for_log ----------

const WaitForLogArgs = FilterFields.extend({
  deviceSn: z.string().optional(),
  pattern: z.string().describe("Regex matched against each streamed log line (full line, including the hilog prefix)."),
  timeoutMs: z.number().int().min(500).max(300000).optional().describe("Max wait. Default 15000."),
  contextLines: z.number().int().min(0).max(50).optional().describe("Number of preceding lines to include in the result. Default 3."),
  tailOnTimeout: z.number().int().min(0).max(200).optional().describe("If timeout fires, include the last N captured lines as a diagnostic tail. Default 20."),
});

export const waitForLogTool = {
  name: "wait_for_log",
  description:
    "Block until a hilog line matches `pattern` (or timeout). Streams hilog with the same filters as logs_start/logs_dump. " +
    "Useful for waiting on app start (`Displayed`), errors, or specific events without polling logs_dump.",
  inputSchema: zodToJsonSchema(WaitForLogArgs, { target: "openApi3" }) as Record<string, unknown>,
};

export async function handleWaitForLog(args: unknown): Promise<ToolResult> {
  const a = WaitForLogArgs.parse(args);
  const sn = sessionDevice(a.deviceSn);
  if (!sn) return errorResult("No deviceSn.");

  let re: RegExp;
  try { re = new RegExp(a.pattern); }
  catch (e: any) { return errorResult(`Invalid pattern regex: ${e.message}`); }

  const timeoutMs = a.timeoutMs ?? 15000;
  const contextLines = a.contextLines ?? 3;
  const tailOnTimeout = a.tailOnTimeout ?? 20;
  const filters = { tag: a.tag, domain: a.domain, level: a.level, pid: a.pid, regex: a.regex };
  const cmdArgs = buildHilogArgs(sn, filters, false);

  return new Promise<ToolResult>((resolve) => {
    const proc = spawn(hdcPath(), cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const startedAt = Date.now();
    const recent: string[] = [];
    const recentCap = Math.max(contextLines, tailOnTimeout, 20);
    let pending = "";
    let settled = false;

    const cleanup = () => { try { proc.kill("SIGTERM"); } catch { /* best effort */ } };
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const line of parts) {
        if (re.test(line)) {
          const tail = recent.slice(-contextLines);
          const body = tail.length > 0 ? `${tail.join("\n")}\n${line}` : line;
          const elapsedMs = Date.now() - startedAt;
          finish(ok(
            `wait_for_log matched in ${elapsedMs} ms (/${a.pattern}/):\n\n${body}`,
            { matched: true, elapsedMs, matchedLine: line }
          ));
          return;
        }
        recent.push(line);
        if (recent.length > recentCap) recent.splice(0, recent.length - recentCap);
      }
    });

    proc.on("error", (err) => {
      finish(errorResult(`wait_for_log: failed to spawn hilog: ${err.message}`));
    });

    proc.on("exit", (code) => {
      if (settled) return;
      const tail = recent.slice(-tailOnTimeout).join("\n").trim();
      finish(errorResult(
        `wait_for_log: hilog exited (code=${code}) before pattern matched.` +
        (tail ? `\n\nLast captured lines:\n${tail}` : "")
      ));
    });

    const timer = setTimeout(() => {
      const tail = recent.slice(-tailOnTimeout).join("\n").trim();
      finish(errorResult(
        `wait_for_log timed out after ${timeoutMs} ms waiting for /${a.pattern}/.` +
        (tail ? `\n\nLast captured lines:\n${tail}` : "\n(no log lines captured)")
      ));
    }, timeoutMs);
  });
}

// ---------- helpers ----------

function stopSession(handle: string, _reason: "user" | "ttl"): void {
  const s = sessions.get(handle);
  if (!s) return;
  try { s.proc.kill("SIGTERM"); } catch { /* best effort */ }
  if (s.ttlTimer) clearTimeout(s.ttlTimer);
  sessions.delete(handle);
}
