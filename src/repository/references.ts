import ts from "typescript";
import { z } from "zod";
const rangeSchema = z.object({
  byteOffset: z.object({ start: z.int().nonnegative(), end: z.int().nonnegative() }),
  start: z.object({ line: z.int().nonnegative() }),
});
const captureSchema = z.object({ text: z.string(), range: rangeSchema });
const matchesSchema = z.array(
  z.object({
    ruleId: z.enum(["import", "export", "require", "dynamic", "type", "parse-error"]),
    text: z.string(),
    range: rangeSchema,
    metaVariables: z.object({ single: z.object({ SOURCE: captureSchema.optional() }) }).optional(),
  }),
);

export interface ModuleReference {
  specifier?: string;
  kind: "import" | "export" | "require" | "dynamic" | "type";
  line: number;
}
export interface ReferenceSyntax {
  status: "analyzed" | "partial" | "unsupported" | "unavailable";
  references: ModuleReference[];
  note?: string;
}

function literalValue(text: string): string | undefined {
  let valid = true;
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
    () => {
      valid = false;
    },
  );
  const kind = scanner.scan();
  if (!valid || scanner.getTokenEnd() !== text.length) {
    return undefined;
  }
  if (
    kind !== ts.SyntaxKind.StringLiteral &&
    kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return undefined;
  }
  return scanner.getTokenValue();
}

function validateRange(item: z.infer<typeof captureSchema>, source: Buffer): void {
  const { start, end } = item.range.byteOffset;
  if (
    end < start ||
    end > source.length ||
    source.subarray(start, end).toString("utf8") !== item.text
  ) {
    throw new Error("AST reference range does not match the inspected source");
  }
}

export function parseReferences(json: string, source: Buffer): ReferenceSyntax {
  const matches = matchesSchema.parse(JSON.parse(json));
  const references: ModuleReference[] = [];
  let errors = 0;
  for (const match of matches.sort((a, b) => a.range.byteOffset.start - b.range.byteOffset.start)) {
    validateRange(match, source);
    if (match.ruleId === "parse-error") {
      errors++;
      continue;
    }
    const capture = match.metaVariables?.single.SOURCE;
    if (!capture) {
      throw new Error("AST reference omitted its source capture");
    }
    validateRange(capture, source);
    references.push({
      kind: match.ruleId,
      specifier: literalValue(capture.text),
      line: match.range.start.line + 1,
    });
  }
  return {
    status: errors ? "partial" : "analyzed",
    references,
    ...(errors ? { note: "AST contains syntax errors; reference coverage is partial" } : {}),
  };
}
