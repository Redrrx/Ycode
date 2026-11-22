import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { relativePath } from "../../repository/tree.ts";
import type { TaskActivity } from "../../activity/task.ts";
import { EXPLORATION_LIMITS as LIMITS, TOOL_NAMES } from "../../config/constants.ts";
import type { RoleConfig } from "../../config/load.ts";
import type { DecisionClient } from "../../decision/client.ts";
import { createTaskDecisionClient } from "../../decision/runtime.ts";
import { emptyUsage } from "../../decision/usage.ts";
import { toolDescriptions } from "../../prompts.ts";
import type { Repository } from "../../repository/source.ts";
import { openRepository, run } from "../../repository/source.ts";
import type { TaskSpec } from "../../workflow/protocol.ts";
import { followReferences } from "./follow.ts";
import { findParameters, inspectionParameters, overviewParameters } from "./parameters.ts";
import { inspectFiles, workspaceOverview } from "./response.ts";
import type { ExplorationResult } from "./result.ts";
import { searchCoverage } from "./search-state.ts";
import { commitSearch, findCode } from "./search.ts";
import type { RepositoryIndex, SearchState } from "./state.ts";
import { finishExploration } from "./workspaces.ts";
type Operation = "overview" | "find" | "inspect";
interface Request {
  target: string;
  notes?: string;
  declarations?: boolean;
  scope?: string;
  workspace?: string;
  search?: string;
  summary?: string;
  sourcePaths?: string[];
  path?: string;
  relatedPaths?: string[];
  startLine?: number;
  endLine?: number;
  referenceOffset?: number;
  depth?: number;
  cursor?: string;
  literal?: string;
  followReferences?: boolean;
}

function inspectionUsage(decisions: DecisionClient | undefined) {
  return decisions?.usage ?? emptyUsage();
}

interface SearchToolsData {
  readonly config: RoleConfig;
  readonly activity: TaskActivity;
  readonly taskSpec: TaskSpec;
  readonly state: SearchState;
}

type SearchTools = Pick<ReturnType<typeof bindSearchTools>, "execute">;

function createExplorationHandlers(
  config: RoleConfig,
  activity: TaskActivity,
  taskSpec: TaskSpec,
  state: SearchState,
): SearchTools {
  return bindSearchTools({ config, activity, taskSpec, state });
}

function bindSearchTools(self: SearchToolsData) {
  return Object.assign(self, {
    execute: searchToolsExecute.bind(undefined, self),
  });
}

function searchToolsDecisionsFor(
  self: SearchToolsData,
  context: ExtensionContext,
  id: string,
  signal: AbortSignal,
): DecisionClient {
  return createTaskDecisionClient(
    context,
    self.config,
    self.taskSpec,
    self.activity,
    id,
    signal,
    self.state.decisionUnavailable,
  );
}

function searchToolsRepositoryFor(
  self: SearchToolsData,
  context: ExtensionContext,
  id: string,
  request: Request,
  signal: AbortSignal,
) {
  const previous = request.workspace ? self.state.workspaces.get(request.workspace) : undefined;
  return openRepository(
    context.cwd,
    request.scope ?? previous?.root ?? ".",
    signal,
    run,
    self.activity.repositoryOperations(id),
  );
}

function searchToolsPerform(
  operation: Operation,
  request: Request,
  repository: Repository,
  workspace: RepositoryIndex,
  decisions: DecisionClient | undefined,
) {
  if (operation === "overview") {
    return workspaceOverview(repository, workspace, request.target, request);
  }
  if (operation === "find") {
    if (!decisions) {
      throw new Error("Missing classifier runtime");
    }
    return findCode(
      repository,
      workspace,
      decisions,
      request.target,
      request.search,
      request.literal,
      true,
    );
  }
  if (!request.path) {
    throw new Error("code_inspect requires path");
  }
  const paths = [request.path, ...(request.relatedPaths ?? [])].map((path) =>
    relativePath(repository.root, resolve(repository.workspaceRoot, path)),
  );
  return inspectFiles(repository, workspace, request.target, paths, {
    startLine: request.startLine,
    endLine: request.endLine,
    declarations: request.declarations,
    referenceOffset: request.referenceOffset,
  });
}

function searchToolsRememberDecisions(
  self: SearchToolsData,
  decisions: DecisionClient | undefined,
): void {
  if (decisions?.unavailable) {
    self.state.decisionUnavailable = true;
  }
}

function searchToolsCommit(
  repository: Repository,
  workspace: RepositoryIndex,
  request: Request,
  result: ExplorationResult,
): void {
  const cursor = request.search
    ? workspace.searches.get(request.search)
    : [...workspace.searches.values()].find(
        (item) => item.target === request.target && item.literal === request.literal,
      );
  if (!cursor) {
    return;
  }
  commitSearch(repository, cursor, result.findings);
  Object.assign(result.coverage, searchCoverage(cursor));
  if (cursor.pending.length && result.stopReason === "exhausted") {
    result.stopReason = "result_limit";
  }
}

async function searchToolsExecute(
  self: SearchToolsData,
  operation: Operation,
  context: ExtensionContext,
  id: string,
  request: Request,
  signal?: AbortSignal,
) {
  let decisions: DecisionClient | undefined;
  try {
    if (!request.target.trim()) {
      throw new Error("A target is required");
    }
    const combined = AbortSignal.any([
      AbortSignal.timeout(LIMITS.deadlineMs),
      ...(signal ? [signal] : []),
    ]);
    const repository = await searchToolsRepositoryFor(self, context, id, request, combined);
    const workspace = await self.state.resolve(
      repository,
      request.workspace,
      operation !== "inspect",
    );
    if (operation === "find" || request.followReferences) {
      decisions = searchToolsDecisionsFor(self, context, id, combined);
    }
    let output = await searchToolsPerform(operation, request, repository, workspace, decisions);
    if (request.followReferences && decisions) {
      output = await followReferences(repository, workspace, output, decisions);
    }
    searchToolsRememberDecisions(self, decisions);
    const result = finishExploration(
      self.state,
      output,
      workspace,
      request,
      operation === "overview",
    );
    if (operation === "find") {
      searchToolsCommit(repository, workspace, request, result);
    }
    for (const finding of result.findings) {
      self.state.sourceHashes.set(
        await realpath(resolve(repository.workspaceRoot, finding.path)),
        finding.sourceHash,
      );
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
      details: result,
      usage: inspectionUsage(decisions),
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text" as const,
          text: `${error instanceof Error ? error.message : String(error)}\nWorkspace root: ${context.cwd}. Paths are relative to this root; parent traversal is prohibited.`,
        },
      ],
      details: undefined,
      isError: true,
      usage: inspectionUsage(decisions),
    };
  }
}

export function createSearchTools(
  config: RoleConfig,
  activity: TaskActivity,
  taskSpec: TaskSpec,
  state: SearchState,
) {
  const handlers = createExplorationHandlers(config, activity, taskSpec, state);
  const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const overview = defineTool({
    name: TOOL_NAMES.overview,
    label: "Workspace Overview",
    description: toolDescriptions.overview,
    annotations,
    parameters: overviewParameters(),
    executionMode: "sequential",
    async execute(id, parameters, signal, _update, context) {
      return handlers.execute("overview", context, id, parameters, signal);
    },
  });
  const find = defineTool({
    name: TOOL_NAMES.find,
    label: "Find Code",
    description: toolDescriptions.find,
    annotations,
    parameters: findParameters(),
    executionMode: "sequential",
    async execute(id, parameters, signal, _update, context) {
      return handlers.execute("find", context, id, parameters, signal);
    },
  });
  const inspect = defineTool({
    name: TOOL_NAMES.inspect,
    label: "Inspect Code",
    description: toolDescriptions.inspect,
    annotations,
    parameters: inspectionParameters(),
    executionMode: "sequential",
    async execute(id, parameters, signal, _update, context) {
      return handlers.execute("inspect", context, id, parameters, signal);
    },
  });
  return [overview, find, inspect];
}
