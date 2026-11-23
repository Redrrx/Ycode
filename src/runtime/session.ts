import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createExtensionRuntime,
  type ExtensionContext,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { TaskActivity } from "../activity/task.ts";
import { requireEffort, WORKER_LIMITS } from "../config/constants.ts";
import type { RoleConfig } from "../config/load.ts";
import type { ProjectDatabase } from "../project/database.ts";
import { createDirectoryStore } from "../project/directories.ts";
import { createExecutionStore } from "../project/execution.ts";
import type { HistoryStore } from "../project/history.ts";
import type { WriteJournal } from "../project/writes.ts";
import { workerPrompt } from "../prompts.ts";
import { createWorkerTools } from "../tools/catalog.ts";
import { createExecutionTools } from "../tools/execution/tools.ts";
import { createSearchState } from "../tools/explore/state.ts";
import { createWorkspaceIndex } from "../tools/explore/workspace-index.ts";
import { workspaceIndex } from "../tools/explore/workspaces.ts";
import { createTaskCompletion } from "../tools/finish.ts";
import { installWorkerUsage } from "../usage/observer.ts";
import type { TaskSpec } from "../workflow/protocol.ts";
import { installWorkingContext } from "./context.ts";
function workerResources(): ResourceLoader {
  const runtime = createExtensionRuntime();

  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: workerPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

async function workerRuntime(
  context: ExtensionContext,
  config: RoleConfig,
  signal: AbortSignal,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, signal });

  for (const role of ["worker", "decision"] as const) {
    signal.throwIfAborted();
    if (role === "decision" && !config.decision.model) {
      continue;
    }
    const provider = context.modelRegistry.getProvider(role);
    const credentials = await context.modelRegistry
      .getProviderAuth(role)
      .catch((error: unknown) => {
        signal.throwIfAborted();
        if (role === "decision") {
          return undefined;
        }
        throw error;
      });
    if (!provider || !credentials?.auth.apiKey) {
      if (role === "decision") {
        continue;
      }
      throw new Error(`Missing ${role} credentials. Run /login ${role}.`);
    }

    runtime.registerNativeProvider(provider);
    await runtime.setRuntimeApiKey(role, credentials.auth.apiKey);
  }

  return runtime;
}

export async function createWorker(
  context: ExtensionContext,
  config: RoleConfig,
  taskSpec: TaskSpec,
  signal: AbortSignal,
  activity: TaskActivity,
  workspaces = createWorkspaceIndex(),
  journal?: WriteJournal,
  history?: HistoryStore,
  database?: ProjectDatabase,
  revision = 1,
) {
  if (!config.worker.model) {
    throw new Error("Choose a model with /login worker before starting a task.");
  }
  const runtime = await workerRuntime(context, config, signal);
  const model = runtime.getModel("worker", config.worker.model);
  if (!model) {
    throw new Error(`Worker model is unavailable: ${config.worker.model}`);
  }

  const exploration = createSearchState(workspaces);
  const execution =
    database && taskSpec.execution?.commands
      ? createExecutionTools(
          config,
          taskSpec,
          activity,
          exploration,
          createExecutionStore(database, taskSpec.id, revision),
          signal,
        )
      : undefined;
  const completion = createTaskCompletion(taskSpec, () =>
    (execution?.completedCheckRuns() ?? []).map((item) => item.check),
  );
  const customTools = createWorkerTools(config, taskSpec, activity, exploration, journal, {
    history,
    directories: database ? { store: createDirectoryStore(database), revision } : undefined,
    execution,
    completion,
  });
  const tools = customTools.map((tool) => tool.name);

  signal.throwIfAborted();
  const created = await createAgentSession({
    cwd: context.cwd,
    model,
    modelRuntime: runtime,
    thinkingLevel: requireEffort("worker", model, config.worker.effort),
    resourceLoader: workerResources(),
    sessionManager: SessionManager.inMemory(context.cwd),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: WORKER_LIMITS.providerRetries },
    }),
    tools,
    customTools,
  });
  completion.install(created.session);
  installWorkerUsage(created.session);
  installWorkingContext(created.session, exploration, (usage) => activity.contextProjection(usage));
  return { ...created, workspaces: workspaceIndex(exploration), execution, completion };
}
