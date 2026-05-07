// Parser for hvigorw output. ArkTS / cmake errors share the same `file:line:col` shape.

const ANSI = /\x1b\[[0-9;]*m/g;

export type BuildIssue = {
  level: "error" | "warning";
  file?: string;
  line?: number;
  column?: number;
  message: string;
};

export type BuildSummary = {
  success: boolean;
  durationText?: string;
  issues: BuildIssue[];
  rawTail: string;
};

export function parseBuildOutput(raw: string): BuildSummary {
  const text = raw.replace(ANSI, "");
  const lines = text.split(/\r?\n/);

  const success = /BUILD SUCCESSFUL/i.test(text);
  const durationMatch = text.match(/BUILD (?:SUCCESSFUL|FAILED)\s+in\s+([^\n]+)/i);
  const durationText = durationMatch ? durationMatch[1].trim() : undefined;

  const issues: BuildIssue[] = [];
  const filePattern = /([^\s:]+\.(?:ets|ts|js|json5|cpp|c|h|hpp)):(\d+)(?::(\d+))?/;

  for (const line of lines) {
    const cleaned = line.replace(/^>\s*hvigor\s*/, "").trim();
    if (!cleaned) continue;

    const isError = /^(?:ERROR|FAILED|FAIL|Error)\b/i.test(cleaned) || /\berror:/i.test(cleaned);
    const isWarn = /^WARN(?:ING)?\b/i.test(cleaned) || /\bwarning:/i.test(cleaned);
    if (!isError && !isWarn) continue;

    const m = cleaned.match(filePattern);
    issues.push({
      level: isError ? "error" : "warning",
      file: m?.[1],
      line: m?.[2] ? Number(m[2]) : undefined,
      column: m?.[3] ? Number(m[3]) : undefined,
      message: cleaned,
    });
  }

  const rawTail = lines.slice(-30).join("\n");

  return { success, durationText, issues, rawTail };
}

export function summarizeBuild(s: BuildSummary): string {
  const errs = s.issues.filter((i) => i.level === "error");
  const warns = s.issues.filter((i) => i.level === "warning");
  const head = s.success
    ? `Build SUCCEEDED${s.durationText ? ` in ${s.durationText}` : ""}`
    : `Build FAILED${s.durationText ? ` in ${s.durationText}` : ""}`;

  const lines: string[] = [`${head} — ${errs.length} errors, ${warns.length} warnings`];

  if (s.issues.length > 0) {
    lines.push("");
    for (const i of s.issues.slice(0, 30)) {
      const tag = i.level === "error" ? "ERROR" : "WARN ";
      const loc = i.file
        ? ` ${i.file}${i.line ? `:${i.line}` : ""}${i.column ? `:${i.column}` : ""}`
        : "";
      lines.push(`${tag}${loc}  ${i.message}`);
    }
    if (s.issues.length > 30) {
      lines.push(`... ${s.issues.length - 30} more`);
    }
  }

  if (!s.success && errs.length === 0) {
    lines.push("");
    lines.push("(No structured errors parsed. Last 30 lines of output:)");
    lines.push(s.rawTail);
  }

  return lines.join("\n");
}
