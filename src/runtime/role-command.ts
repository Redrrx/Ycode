import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effortSchema, requireEffort } from "../config/constants.ts";
import type { WorkflowController } from "../workflow/controller.ts";
type Role = "worker" | "summarizer";

export function registerRoleCommand(
  pi: ExtensionAPI,
  controller: WorkflowController,
  refresh: (context: ExtensionContext) => void,
  role: Role,
): void {
  pi.registerCommand(role, {
    description: `Show the selected model and effort, or /${role} effort <level|clear>`,
    getArgumentCompletions(prefix) {
      return ["effort", "effort clear", ...effortSchema.options.map((level) => `effort ${level}`)]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    async handler(args, context) {
      try {
        const { model: id } = controller.getRoleConfiguration()[role];
        if (!id) {
          throw new Error(`Set ${role}.model in config.json and /reload.`);
        }
        const model = context.modelRegistry.find(role, id);
        if (!model) {
          throw new Error(`${role} model unavailable: ${id}`);
        }
        const words = args.trim().split(/\s+/u).filter(Boolean);
        if (words.length && words.join(" ") !== "effort") {
          if (words.length !== 2 || words[0] !== "effort") {
            throw new Error(`Usage: /${role} [effort <level|clear>]`);
          }
          const effort =
            words[1] === "clear"
              ? undefined
              : requireEffort(role, model, effortSchema.parse(words[1]));
          controller.setEffort(role, effort);
          refresh(context);
        }
        const effort = controller.getRoleConfiguration()[role].effort;
        context.ui.notify(
          `${role}: ${id} · effort ${effort ?? "not selected"}\nSupported: ${getSupportedThinkingLevels(model).join(", ")}`,
          "info",
        );
      } catch (error) {
        context.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
