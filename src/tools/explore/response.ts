import { EXPLORATION_LIMITS as LIMITS } from "../../config/constants.ts";
import type { Repository } from "../../repository/source.ts";
import { inspectFile, type InspectionOptions } from "./inspect.ts";
import { workspaceStructure, type OverviewOptions } from "./overview.ts";
import { COVERAGE_NOTE, fitResult, type ExplorationResult, type Finding } from "./result.ts";
import type { RepositoryIndex } from "./state.ts";
export function explorationResult(
  repository: Repository,
  state: RepositoryIndex,
  decisionCalls: number,
  goal: string,
  findings: Finding[],
  stopReason: string,
  includeTree = false,
  warnings: string[] = [],
): ExplorationResult {
  let status: ExplorationResult["status"] = "findings";
  if (["inspection_error", "blocked", "deadline", "unreadable_paths"].includes(stopReason)) {
    status = "partial";
  } else if (findings.length === 0) {
    status = "empty";
  }
  return fitResult({
    workspaceId: state.id,
    goal,
    workspace: repository.workspaceRoot,
    scope: repository.root,
    status,
    stopReason,
    findings,
    tree: includeTree ? state.visibleTree() : undefined,
    coverage: {
      inventoriedFiles: state.files.size,
      uniqueExaminedFiles: state.examined.size,
      outlineOperations: state.outlined,
      referenceASTOperations: state.referenceAnalyses,
      successfulReadOperations: state.reads,
      rootDirectoryEntries: state.directoryEntries,
      inspectionAttempts: state.attempts,
      findingsThisCall: findings.length,
    },
    decisionCalls,
    warnings: warnings.slice(-LIMITS.warnings),
    ...(state.notices.length ? { notices: [...state.notices] } : {}),
    note: COVERAGE_NOTE,
  });
}

function inspectionFailure(
  warnings: string[],
  path: string,
  signal: AbortSignal,
  error: unknown,
): string {
  const reason: unknown = signal.reason;
  if (signal.aborted && reason instanceof Error && reason.name === "TimeoutError") {
    warnings.push(
      `${path}: inspection deadline reached; returning findings collected before the timeout.`,
    );
    return "deadline";
  }
  if (signal.aborted) {
    throw error;
  }
  warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  return "inspection_error";
}

export async function workspaceOverview(
  repository: Repository,
  state: RepositoryIndex,
  goal: string,
  options: OverviewOptions = {},
) {
  for (const path of state.files) {
    state.known.add(path);
  }
  return {
    ...explorationResult(repository, state, 0, goal, [], "structure_only"),
    structure: workspaceStructure(state, options),
    status: state.inventoryComplete ? ("findings" as const) : ("partial" as const),
  };
}

export async function inspectFiles(
  repository: Repository,
  state: RepositoryIndex,
  goal: string,
  paths: string[],
  options: InspectionOptions = {},
) {
  if (paths.length === 0 || paths.length > LIMITS.findingsPerCall) {
    throw new Error(`Read 1 to ${LIMITS.findingsPerCall} files per operation`);
  }
  const findings: Finding[] = [];
  const warnings: string[] = [];
  let stopReason = "direct_inspection";
  for (const path of [...new Set(paths)]) {
    try {
      const fileOptions = { ...options };
      if (path !== paths[0]) {
        delete fileOptions.startLine;
        delete fileOptions.endLine;
        delete fileOptions.referenceOffset;
      }
      const result = await inspectFile(repository, state, path, fileOptions);
      state.examined.set(path, "Focused source inspection");
      findings.push(result.finding);
      warnings.push(...result.warnings);
    } catch (error) {
      stopReason = inspectionFailure(warnings, path, repository.signal, error);
      if (stopReason === "deadline") {
        break;
      }
    }
  }
  if (findings.length === 0 && stopReason === "inspection_error") {
    throw new Error(warnings.at(-1) ?? "No requested file could be inspected");
  }
  return explorationResult(repository, state, 0, goal, findings, stopReason, false, warnings);
}

export async function inspectCode(
  repository: Repository,
  state: RepositoryIndex,
  goal: string,
  localPath: string,
) {
  return inspectFiles(repository, state, goal, [localPath]);
}
