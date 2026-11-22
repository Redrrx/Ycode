import { resolve } from "node:path";
import { relativePath } from "../../repository/tree.ts";
import { EXPLORATION_LIMITS } from "../../config/constants.ts";
import { fitResult, type ExplorationResult } from "./result.ts";
import type { RepositoryIndex, SearchState } from "./state.ts";
export function updateSummary(
  state: RepositoryIndex,
  summary: string | undefined,
  paths: string[] | undefined,
): void {
  if (summary === undefined) {
    if (paths !== undefined) {
      throw new Error("sourcePaths requires summary");
    }
    return;
  }
  if (!summary.trim() || !paths?.length) {
    throw new Error("Workspace summary requires text and inspected sourcePaths");
  }
  for (const path of paths) {
    const local = relativePath(state.root, resolve(state.workspace, path));
    if (!state.examined.has(local)) {
      throw new Error(`Summary path has not been inspected in this workspace: ${path}`);
    }
  }
  state.summary = summary.trim();
  state.summaryPaths = [...new Set(paths)];
  state.summaryStale = false;
}

export function finishExploration(
  state: SearchState,
  output: ExplorationResult,
  workspace: RepositoryIndex,
  request: { summary?: string; sourcePaths?: string[]; notes?: string },
  overview: boolean,
) {
  const warnings = [...output.warnings];
  try {
    updateSummary(workspace, request.summary, request.sourcePaths);
  } catch (error) {
    warnings.push(
      `Workspace summary not saved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (request.notes !== undefined) {
    state.notes = request.notes;
  }
  state.saveWorkspace(workspace);
  return fitResult({
    ...output,
    warnings: warnings.slice(-EXPLORATION_LIMITS.warnings),
    notices: [...(output.notices ?? []), ...state.recordFindings(workspace.id, output.findings)],
    workspaces: overview ? workspaceIndex(state) : undefined,
    workspaceCount: overview ? state.workspaces.list().length : undefined,
  });
}

export function workspaceIndex(state: SearchState) {
  return state.workspaces
    .list()
    .sort(
      (left, right) =>
        Number(state.investigations.has(right.id)) - Number(state.investigations.has(left.id)),
    )
    .slice(0, EXPLORATION_LIMITS.workspacePreviews)
    .map((workspace) => ({
      id: workspace.id,
      root: workspace.root,
      summary: workspace.summary,
      sourcePaths: workspace.sourcePaths,
      stale: workspace.stale,
    }));
}
