// Crew's SKILL_LOADER frontmatter dialect, not a general YAML or Markdown parser.
// Plain scalars allow ': ' and inline '#'; only matched wrapping quotes disappear.
const BLOCK_HEADER = /^([|>])(?:([1-9])([+-]?)|([+-]?)([1-9]?))(?:[ \t]+#.*)?$/;

function unquote(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
    const inner = value.slice(1, -1);
    return value[0] === "'" ? inner.replaceAll("''", "'") : inner;
  }
  return value;
}

function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, "").length;
}

function foldBlock(block: string[], style: string, chomp: string, explicitIndent?: number): string {
  const allBreaks = chomp === "+" ? "\n".repeat(block.length) : "";
  const first = block.find((line) => line.replace(/^ +/, ""));
  if (explicitIndent === undefined && first === undefined) return allBreaks;
  const indent = explicitIndent ?? indentOf(first!);
  const lines = block.map((line) =>
    /^\s+$/.test(line.slice(0, indent)) || !line.trim() ? line.slice(indent) : line.trimStart(),
  );
  if (!lines.some(Boolean)) return allBreaks;
  let end = lines.length;
  while (end && !lines[end - 1]) end--;
  const suffix = chomp === "-" ? "" : chomp === "+" ? "\n".repeat(lines.length - end + 1) : "\n";
  const content = lines.slice(0, end);
  if (style === "|") return content.join("\n") + suffix;

  let result = "";
  let blanks = 0;
  let started = false;
  let previousIndented = false;
  for (const line of content) {
    if (!line) { blanks++; continue; }
    const indented = /^\s/.test(line);
    if (started) {
      result += blanks
        ? "\n".repeat(blanks + (indented || previousIndented ? 1 : 0))
        : indented || previousIndented ? "\n" : " ";
    } else {
      result += "\n".repeat(blanks);
    }
    result += line;
    started = true;
    previousIndented = indented;
    blanks = 0;
  }
  return result + suffix;
}

function scan(text: string): { fields: Map<string, string>; violations: string[] } {
  const fields = new Map<string, string>();
  const violations: string[] = [];
  if (/\r(?!\n)/.test(text)) violations.push("CR-only line endings are not supported; use LF or CRLF");
  // Count physical lines, including an unterminated final line.
  const lineCount = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  if (lineCount > 500) violations.push(`SKILL.md exceeds 500 lines (${lineCount})`);
  if (!/^---\r?\n/.test(text)) violations.push("opening --- must be at column zero followed by a newline");
  // Crew accepts trailing text on the closing fence, not the opening fence.
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    violations.push("frontmatter requires a closing --- at column zero");
  } else {
    const lines = match[1].replace(/\r\n/g, "\n").split("\n");
    let currentKey = "";
    for (let i = 0; i < lines.length;) {
      const line = lines[i++].replace(/\r$/, "");
      if (/^\s/.test(line)) {
        if (/^\s+(?:-\s|[[{]|[^\s:]+\s*:)/.test(line)) {
          violations.push(`line ${i + 1}: nested YAML under ${currentKey || "frontmatter"} is not supported`);
        }
        continue;
      }
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim();
      let value = line.slice(colon + 1).trim();
      currentKey = key;
      if (fields.has(key)) violations.push(`line ${i + 1}: duplicate key ${key}`);
      if (key === "hooks" || key === "allowed-tools") {
        violations.push(`line ${i + 1}: ${key}: is unsupported by Crew skills`);
      }
      const header = value.match(BLOCK_HEADER);
      if (header) {
        const explicitIndent = header[2] || header[5] ? Number(header[2] || header[5]) : undefined;
        let contentIndent = explicitIndent;
        let blankFloor = 0;
        const block: string[] = [];
        while (i < lines.length) {
          const next = lines[i].replace(/\r$/, "");
          if (next.replace(/^ +/, "")) {
            const indent = indentOf(next);
            if (indent === 0) break;
            if (contentIndent === undefined) {
              if (indent < blankFloor) break;
              contentIndent = indent;
            }
            if (indent < contentIndent) break;
          } else if (contentIndent === undefined) {
            blankFloor = Math.max(blankFloor, next.length);
          }
          block.push(next);
          i++;
        }
        // Key-like prose inside a block scalar remains scalar content.
        value = foldBlock(block, header[1], header[3] || header[4] || "", explicitIndent);
      } else {
        if (/^[-[{]/.test(value)) violations.push(`line ${i + 1}: nested YAML value for ${key} is not supported`);
        value = unquote(value);
      }
      fields.set(key, value);
    }
  }
  for (const key of ["name", "description"]) {
    if (!fields.get(key)?.trim()) violations.push(`${key} is required and must be non-empty after unquoting`);
  }
  return { fields, violations };
}

/** Validate supplied bytes after runner generation, before App Kit mutation.
 * Any violation makes the collector throw, with no bypass. This is build-time
 * conformance, not runtime permission enforcement. */
export function validateCrewSkillFrontmatter(text: string, path: string): string[] {
  return scan(text).violations.map((violation) => `${path}: ${violation}`);
}

/** Decode only after validation succeeds; this helper is not a gate. */
export function parseCrewSkillFrontmatter(text: string): ReadonlyMap<string, string> {
  return scan(text).fields;
}
