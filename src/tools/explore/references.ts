import { isBuiltin } from "node:module";
import { resolve } from "node:path";
import { relativePath } from "../../repository/tree.ts";
import { EXPLORATION_LIMITS as LIMITS } from "../../config/constants.ts";
import type { ModuleResolver } from "../../repository/module-resolution.ts";
import { createModuleResolver } from "../../repository/module-resolution.ts";
import { referenceLanguage } from "../../repository/reference-rules.ts";
import type { ModuleReference, ReferenceSyntax } from "../../repository/references.ts";
import type { Repository } from "../../repository/source.ts";
import type { RepositoryIndex } from "./state.ts";
async function syntaxFor(
  repository: Repository,
  state: RepositoryIndex,
  path: string,
  source: Buffer,
  digest: string,
): Promise<ReferenceSyntax> {
  if (!referenceLanguage(path)) {
    return { status: "unsupported", references: [] };
  }
  const cached = state.referenceSyntax.get(path);
  if (cached?.digest === digest) {
    return cached.syntax;
  }
  let syntax: ReferenceSyntax;
  state.referenceAnalyses++;
  try {
    syntax = await repository.referenceSyntax(path, source);
  } catch (error) {
    repository.signal.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    syntax = {
      status: "unavailable",
      references: [],
      note: `AST reference analysis unavailable: ${reason.slice(0, 240)}`,
    };
  }
  state.referenceSyntax.set(path, { digest, syntax });
  return syntax;
}

function label(reference: ModuleReference): string {
  return (
    reference.specifier?.slice(0, 160) ?? `Computed ${reference.kind} at line ${reference.line}`
  );
}

async function resolveOne(
  reference: ModuleReference,
  resolver: ModuleResolver,
  repository: Repository,
): Promise<{ path?: string; unresolved?: string }> {
  try {
    const result = resolver.resolve(reference);
    if (!result.path) {
      return { unresolved: result.unresolved };
    }
    const local = relativePath(repository.root, resolve(repository.workspaceRoot, result.path));
    if (await repository.exists(local)) {
      return { path: local };
    }
    return { unresolved: `${label(reference)} (target is outside scope or unavailable)` };
  } catch (error) {
    repository.signal.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    return { unresolved: `${label(reference)} (resolution unavailable: ${reason.slice(0, 160)})` };
  }
}

async function resolvePage(repository: Repository, path: string, selected: ModuleReference[]) {
  const paths = new Set<string>();
  const unresolved = new Set<string>();
  const notes: string[] = [];
  if (!selected.length) {
    return { paths: [], unresolved: [], notes };
  }
  try {
    const resolver = createModuleResolver(
      repository.workspaceRoot,
      resolve(repository.root, path),
      repository.signal,
    );
    for (const reference of selected) {
      const result = await resolveOne(reference, resolver, repository);
      if (result.path) {
        paths.add(result.path);
      }
      if (result.unresolved) {
        unresolved.add(result.unresolved);
      }
    }
    notes.push(...resolver.warnings);
  } catch (error) {
    repository.signal.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    notes.push(`Module resolution incomplete: ${reason.slice(0, 240)}`);
    for (const reference of selected) {
      unresolved.add(`${label(reference)} (resolution unavailable)`);
    }
  }
  return { paths: [...paths], unresolved: [...unresolved], notes };
}

function analysisStatus(syntax: ReferenceSyntax, problems: number): ReferenceSyntax["status"] {
  return syntax.status === "analyzed" && problems ? "partial" : syntax.status;
}

export async function localReferences(
  source: Buffer,
  path: string,
  repository: Repository,
  state: RepositoryIndex,
  digest: string,
  offset = 0,
) {
  repository.signal.throwIfAborted();
  const previous = state.referenceSyntax.get(path);
  const syntax = await syntaxFor(repository, state, path, source, digest);
  const candidates = syntax.references.filter(
    (item) => item.specifier === undefined || !isBuiltin(item.specifier),
  );
  const changed = previous !== undefined && previous.digest !== digest;
  const pageOffset = changed || offset > candidates.length ? 0 : offset;
  const selected = candidates.slice(pageOffset, pageOffset + LIMITS.referenceCount);
  const page = await resolvePage(repository, path, selected);
  const notes = [...(syntax.note ? [syntax.note] : []), ...page.notes];
  if (pageOffset !== offset) {
    notes.push("Reference page restarted: source changed or offset exceeds current results");
  }
  const next = pageOffset + selected.length;
  return {
    paths: page.paths,
    unresolved: page.unresolved,
    analysis: {
      status: analysisStatus(syntax, notes.length + page.unresolved.length),
      total: candidates.length,
      offset: pageOffset,
      nextOffset: next < candidates.length ? next : null,
      ...(notes.length ? { notes } : {}),
    },
  };
}
