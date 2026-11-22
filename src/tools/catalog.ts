import type { TaskActivity } from "../activity/task.ts";
import type { RoleConfig } from "../config/load.ts";
import type { DirectoryStore } from "../project/directories.ts";
import type { HistoryStore } from "../project/history.ts";
import { historyStoreTool } from "../project/tool.ts";
import type { WriteJournal } from "../project/writes.ts";
import type { TaskSpec } from "../workflow/protocol.ts";
import { executionTools, type ExecutionTools } from "./execution/tools.ts";
import { createSearchState } from "./explore/state.ts";
import { createSearchTools } from "./explore/tool.ts";
import type { TaskCompletion } from "./finish.ts";
import { directoryTool } from "./mutate/directories.ts";
import { createMutationTools } from "./mutate/tools.ts";
interface Services {
  history?: HistoryStore;
  directories?: { store: DirectoryStore; revision: number };
  execution?: ExecutionTools;
  completion?: TaskCompletion;
}

export function createWorkerTools(
  config: RoleConfig,
  taskSpec: TaskSpec,
  activity: TaskActivity,
  state = createSearchState(),
  journal?: WriteJournal,
  services: Services = {},
) {
  return [
    ...createSearchTools(config, activity, taskSpec, state),
    ...(taskSpec.mode === "edit"
      ? createMutationTools(
          taskSpec,
          state.sourceHashes,
          (path) => state.changed(path),
          journal,
          (id) => activity.operationId(id),
        )
      : []),
    ...(services.history ? [historyStoreTool(services.history)] : []),
    ...(taskSpec.mode === "edit" && services.directories
      ? [
          directoryTool(
            taskSpec,
            services.directories.revision,
            services.directories.store,
            (path) => state.changed(path),
          ),
        ]
      : []),
    ...(taskSpec.execution?.commands && services.execution
      ? executionTools(services.execution)
      : []),
    ...(services.completion ? [services.completion.tool()] : []),
  ];
}
