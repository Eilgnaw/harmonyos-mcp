export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

export function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError: false,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function okWith(content: ToolContent[], structured?: Record<string, unknown>): ToolResult {
  return {
    content,
    isError: false,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function errorResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function truncate(text: string, max = 4000): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.2));
  return `${head}\n\n... [${text.length - head.length - tail.length} chars omitted] ...\n\n${tail}`;
}
