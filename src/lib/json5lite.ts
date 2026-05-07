// Minimal JSON5 loader for HarmonyOS config files.
// Handles: line comments, block comments, trailing commas, single-quoted strings.
// Does NOT handle: unquoted keys, multi-line strings. HarmonyOS json5 files don't use these.

import { readFileSync } from "node:fs";

export function parseJson5(text: string): unknown {
  const cleaned = stripCommentsAndTrailingCommas(text);
  return JSON.parse(cleaned);
}

export function readJson5(path: string): unknown {
  return parseJson5(readFileSync(path, "utf8"));
}

function stripCommentsAndTrailingCommas(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  let inString: '"' | "'" | null = null;

  while (i < n) {
    const c = input[i];
    const next = input[i + 1];

    if (inString) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === inString) {
        if (inString === "'") {
          out += '"';
        } else {
          out += c;
        }
        inString = null;
        i++;
        continue;
      }
      if (inString === "'" && c === '"') {
        out += '\\"';
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      inString = c;
      out += c === "'" ? '"' : c;
      i++;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    if (c === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(input[j])) j++;
      if (j < n && (input[j] === "}" || input[j] === "]")) {
        i = j;
        continue;
      }
    }

    out += c;
    i++;
  }

  return out;
}
