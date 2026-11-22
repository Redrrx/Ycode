import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effortSchema, requireEffort } from "../config/constants.ts";
import type { WorkflowController } from "../workflow/controller.ts";
type Role = "worker" | "summarizer";

export function registerRoleCommands(
  pi: ExtensionAPI,
  controller: WorkflowController,
  refresh: (context: ExtensionContext) => void,
): void {
  function configure(role: Role, args: string, context: ExtensionContext) {
    try {
      const { model: id } = controller.getRoleConfiguration()[role];
      if (!id) {
        throw new Error(`Choose a model with /login ${role}.`);
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
  }
  for (const role of ["worker", "summarizer"] as const) {
    pi.registerCommand(role, {
      description: `Show ${role} model and supported effort levels`,
      handler: async (args, context) => configure(role, args, context),
    });
  }
  pi.registerCommand("effort", {
    description: "Set project effort: /effort <level|clear> <worker|summarizer>",
    async handler(args, context) {
      const [level, role, ...rest] = args.trim().split(/\s+/u);
      if (!level || (role !== "worker" && role !== "summarizer") || rest.length) {
        context.ui.notify("Usage: /effort <level|clear> <worker|summarizer>", "error");
        return;
      }
      configure(role, `effort ${level}`, context);
    },
  });
}
