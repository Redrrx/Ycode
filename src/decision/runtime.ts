import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskActivity } from "../activity/task.ts";
import type { RoleConfig } from "../config/load.ts";
import type { TaskSpec } from "../workflow/protocol.ts";
import type { DecisionClient } from "./client.ts";
import { createDecisionClient } from "./client.ts";
export function createTaskDecisionClient(
  context: ExtensionContext,
  config: RoleConfig,
  taskSpec: TaskSpec,
  activity: TaskActivity,
  id: string,
  signal: AbortSignal,
  unavailable = false,
): DecisionClient {
  const decisions = createDecisionClient(
    (input, requestSignal) => {
      const model = context.modelRegistry.findOfType(
        "classifier",
        "decision",
        config.decision.model,
      );
      if (!model) {
        throw new Error(
          `Configured decision classifier is unavailable: decision/${config.decision.model}. Check provider registration and /login decision.`,
        );
      }
      return context.modelRegistry.classify(model, input, { signal: requestSignal });
    },
    signal,
    activity.decisions(id),
    {
      objective: taskSpec.objective.slice(0, 1000),
      constraints: taskSpec.constraints.join("\n").slice(0, 2000),
    },
  );
  decisions.unavailable = unavailable || !config.decision.model;
  return decisions;
}
