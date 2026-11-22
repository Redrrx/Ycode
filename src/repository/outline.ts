import { z } from "zod";
const positionSchema = z.object({ line: z.int().nonnegative() });
const byteRangeSchema = z
  .object({
    start: z.int().nonnegative(),
    end: z.int().positive(),
  })
  .refine((range) => range.end > range.start, "AST range must be nonempty");

const baseItemSchema = z.object({
  name: z.string(),
  signature: z.string(),
  symbolType: z.string().default("declaration"),
  range: z.object({ byteOffset: byteRangeSchema, start: positionSchema }),
  isImport: z.boolean().optional(),
});

type OutlineItem = z.infer<typeof baseItemSchema> & { members?: OutlineItem[] };

const itemSchema: z.ZodType<OutlineItem> = baseItemSchema.extend({
  members: z.lazy(() => z.array(itemSchema)).optional(),
});

const outlineSchema = z.array(z.object({ items: z.array(itemSchema) }));

export interface SymbolInfo {
  name: string;
  qualifiedName: string;
  kind: string;
  signature: string;
  start: number;
  end: number;
  line: number;
}

function collectSymbols(items: OutlineItem[], byteLength: number, parent = ""): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];

  for (const item of items) {
    const { start, end } = item.range.byteOffset;
    if (end > byteLength) {
      throw new Error("Invalid AST range: exceeds source length");
    }

    const qualifiedName = parent ? `${parent}.${item.name}` : item.name;
    const forwarding = item.symbolType === "module" && !item.members?.length;
    if (!item.isImport && !forwarding) {
      symbols.push({
        name: item.name,
        qualifiedName,
        kind: item.symbolType,
        signature: item.signature,
        start,
        end,
        line: item.range.start.line + 1,
      });
    }

    symbols.push(...collectSymbols(item.members ?? [], byteLength, qualifiedName));
  }

  return symbols;
}

export function parseOutline(json: string, byteLength: number): SymbolInfo[] {
  const parsed: unknown = JSON.parse(json);
  const result = outlineSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error("Invalid ast-grep outline JSON or AST range", { cause: result.error });
  }

  return result.data.flatMap((document) => collectSymbols(document.items, byteLength));
}
