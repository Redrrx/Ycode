import { createHash } from "node:crypto";
import { EXPLORATION_LIMITS as LIMITS } from "../../config/constants.ts";
import { supportsOutline } from "../../repository/commands.ts";
import type { SymbolInfo } from "../../repository/outline.ts";
import type { Repository } from "../../repository/source.ts";
import { localReferences } from "./references.ts";
import type { Finding } from "./result.ts";
import { MANIFESTS, type RepositoryIndex } from "./state.ts";
export function sourceHash(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

export interface InspectionOptions {
  startLine?: number;
  endLine?: number;
  declarations?: boolean;
  referenceOffset?: number;
  select?: (source: Buffer, symbols: SymbolInfo[]) => Promise<SymbolInfo[]>;
}

function lineExcerpt(source: Buffer, options: InspectionOptions) {
  const lines = source.toString("utf8").split("\n");
  const start = options.startLine ?? 1;
  const end = Math.min(options.endLine ?? lines.length, lines.length);
  if (start < 1 || start > lines.length || end < start) {
    throw new Error("Invalid source line range");
  }
  let content = "";
  let next = start;
  let partialLine: number | undefined;
  while (next <= end) {
    const line = `${next}: ${lines[next - 1]}\n`;
    if (content.length + line.length > LIMITS.excerptChars) {
      if (!content) {
        content = `${line.slice(0, LIMITS.excerptChars)}\n[Line ${next} exceeds the character limit; remainder omitted]`;
        partialLine = next;
        next++;
      }
      break;
    }
    content += line;
    next++;
  }
  return {
    content: content + (next <= lines.length ? `\n[More source: request startLine ${next}]` : ""),
    range: {
      startLine: start,
      endLine: next - 1,
      nextLine: next <= lines.length ? next : null,
      ...(partialLine !== undefined ? { partialLine } : {}),
    },
  };
}

function sourceExcerpt(source: Buffer, symbols: SymbolInfo[]): string {
  const text = source.toString("utf8");
  if (text.length <= LIMITS.excerptChars) {
    return text;
  }
  if (symbols.length === 0) {
    return `${text.slice(0, LIMITS.excerptChars)}\n[Remaining source omitted]`;
  }
  const headerBudget = Math.floor(LIMITS.excerptChars / 4);
  const header = `File prefix (line 1; shortened):\n${text.slice(0, headerBudget)}`;
  const perSymbol = Math.floor((LIMITS.excerptChars - header.length) / Math.max(1, symbols.length));
  const snippets = symbols.map((symbol) => {
    const label = `\n${symbol.kind} ${symbol.qualifiedName}, line ${symbol.line}:\n`;
    const code = source.subarray(symbol.start, symbol.end).toString("utf8");
    return label + code.slice(0, Math.max(0, perSymbol - label.length));
  });
  return `${header}${snippets.join("")}\n[Other source omitted; excerpts may end within declarations]`;
}

async function outlineFor(
  repository: Repository,
  state: RepositoryIndex,
  path: string,
  source: Buffer,
  digest: string,
  warnings: string[],
): Promise<SymbolInfo[]> {
  const cached = state.outlines.get(path);
  if (cached?.digest === digest) {
    return cached.symbols;
  }
  try {
    const symbols = await repository.outline(path, source);
    state.outlined++;
    state.reads++;
    state.outlines.set(path, { digest, symbols });
    return symbols;
  } catch (error) {
    repository.signal.throwIfAborted();
    if (error instanceof Error && error.message.startsWith("File changed during inspection:")) {
      throw error;
    }
    warnings.push(
      `AST unavailable for ${path}; returning text: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

export async function inspectFile(
  repository: Repository,
  state: RepositoryIndex,
  path: string,
  options: InspectionOptions = {},
): Promise<{ finding: Finding; warnings: string[] }> {
  const warnings: string[] = [];
  state.attempts++;
  const source = await repository.read(path);
  state.reads++;
  state.known.add(path);
  const digest = sourceHash(source);
  const symbols =
    (options.declarations ||
      (options.select && source.toString("utf8").length > LIMITS.excerptChars)) &&
    supportsOutline(path)
      ? await outlineFor(repository, state, path, source, digest, warnings)
      : [];
  const selected = options.select ? await options.select(source, symbols) : symbols;
  const excerpt = options.select
    ? { content: sourceExcerpt(source, selected), range: undefined }
    : lineExcerpt(source, options);
  const { content, range } = excerpt;
  if (options.select) {
    const current = await repository.read(path);
    state.reads++;
    if (sourceHash(current) !== digest) {
      throw new Error(`File changed during inspection: ${path}; no stale source returned`);
    }
  }
  const references = await localReferences(
    source,
    path,
    repository,
    state,
    digest,
    options.referenceOffset,
  );
  return {
    warnings,
    finding: {
      path: repository.displayPath(path),
      sourceHash: digest,
      kind: MANIFESTS.has(path) ? "manifest" : "source",
      declarations: selected
        .slice(0, LIMITS.declarationsReturned)
        .map((symbol) => ({ name: symbol.qualifiedName, kind: symbol.kind, line: symbol.line })),
      references: references.paths.map((reference) => repository.displayPath(reference)),
      unresolvedReferences: references.unresolved,
      referenceAnalysis: references.analysis,
      content,
      range,
      truncated: options.select
        ? source.toString("utf8").length > LIMITS.excerptChars
        : /\[(?:More source:|Line \d+ exceeds)/u.test(content),
    },
  };
}
