import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerActivityInspector } from "./activity/inspect.ts";
import { createActivityLog } from "./activity/log.ts";
import { registerActivityRenderer } from "./activity/renderer.ts";
import { loadConfig } from "./config/load.ts";
import { registerLifecycle } from "./runtime/lifecycle.ts";
import {
  mainResponse,
  mainResponseText,
  registerMainGuards,
  reportSetupError,
} from "./runtime/main.ts";
import { registerRoleProviders } from "./runtime/providers.ts";
import { registerRoleCommands } from "./runtime/role-command.ts";
import { registerSummarizer } from "./runtime/summarizer-hooks.ts";
import { registerUsageReports } from "./usage/report.ts";
import { createWorkflowController } from "./workflow/controller.ts";
export default async function ycode(pi: ExtensionAPI) {
  const config = await loadConfig();
  registerRoleProviders(pi, config);
  const activity = createActivityLog(pi);
  const controller = createWorkflowController(pi, config, activity);
  registerActivityRenderer(pi, activity);
  registerActivityInspector(pi, activity, () => controller.getChangeHistory());
  registerUsageReports(pi, activity);
  const lifecycle = registerLifecycle(pi, controller, activity);
  const active = lifecycle.active;
  registerMainGuards(pi, controller, active);
  registerSummarizer(pi, activity, () => controller.getRoleConfiguration(), active);

  const showRoles = (context: ExtensionContext) => {
    if (lifecycle.enabled() && context.hasUI) {
      const { worker, summarizer, decision } = controller.getRoleConfiguration();
      context.ui.setStatus(
        "roles",
        `Main: ${context.model?.id ?? "not selected"} · Worker: ${worker.model || "not selected"} (${worker.effort ?? "effort unset"}) · Decision: ${decision.model || "not selected"} · Summarizer: ${summarizer.model || "not selected"} (${summarizer.effort ?? "effort unset"})`,
      );
    }
  };
  registerRoleCommands(pi, controller, showRoles);
  pi.on("model_select", (_event, context) => showRoles(context));
  pi.on("session_start", (_event, context) => showRoles(context));
  pi.on("session_tree", (_event, context) => {
    if (!active()) {
      return;
    }
    controller.restore();
    try {
      activity.restore(context);
    } catch (error) {
      reportSetupError(pi, error);
    }
  });
  pi.on("message_end", (event) => {
    if (!active() || event.message.role !== "assistant") {
      return;
    }
    const text = event.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    controller.captureResponse(event.message.timestamp, text, event.message);
    return { message: mainResponse(event.message, Boolean(controller.getPendingReview())) };
  });
  pi.on("turn_end", async (event, context) => {
    if (!active()) {
      return;
    }
    const result = await controller.handleTurn(event, context);
    return active() ? result : undefined;
  });
  pi.registerMarkdownTransformer((markdown, context) => {
    if (!active() || context.messageType !== "assistant") {
      return markdown;
    }
    return context.isStreaming ? "" : mainResponseText(markdown);
  });
}
