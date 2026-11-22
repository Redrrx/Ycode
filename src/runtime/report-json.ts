function escapeQuotedControls(text: string): string {
  let quoted = false;
  let escaped = false;
  let output = "";
  for (const character of text) {
    if (quoted && !escaped && character.charCodeAt(0) < 0x20) {
      output += JSON.stringify(character).slice(1, -1);
      continue;
    }
    output += character;
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    }
  }
  return output;
}

export function parseReportJson(text: string): unknown {
  const json = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1");
  try {
    return JSON.parse(json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    const normalized = escapeQuotedControls(json);
    if (normalized === json) {
      throw error;
    }
    return JSON.parse(normalized);
  }
}
