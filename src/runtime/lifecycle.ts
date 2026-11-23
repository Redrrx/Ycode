import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActivityLog } from "../activity/log.ts";
import type { WorkflowController } from "../workflow/controller.ts";
import { registerWorkerGuard, reportSetupError } from "./main.ts";

export function registerLifecycle(
  pi: ExtensionAPI,
  controller: WorkflowController,
  activity: ActivityLog,
) {
  let enabled = true;
  let ready = false;
  let previousTools: string[] | undefined;
  let disposal: Promise<void> | undefined;
  const active = () => enabled && ready;
  const restoreTools = () => {
    if (previousTools) {
      pi.setActiveTools(previousTools);
    }
  };
  const dispose = () => (disposal ??= controller.dispose().finally(restoreTools));
  registerWorkerGuard(
    pi,
    controller,
    () => enabled,
    () => ready,
  );
  pi.on("session_start", async (_event, context) => {
    previousTools = pi.getActiveTools();
    try {
      activity.restore(context);
      await controller.openProject(context);
      controller.restore();
      ready = true;
    } catch (error) {
      reportSetupError(pi, error);
    }
  });
  pi.on("agent_settled", (event) => {
    if (!active()) {
      return;
    }
    controller.pauseRun(
      event.aborted ? "Execution cancelled; resume explicitly" : "Run paused; resume explicitly",
    );
  });
  pi.on("session_shutdown", async () => {
    await dispose();
  });
  pi.registerCommand("unload", {
    description: "Disable Ycode for this session: /unload ycode",
    async handler(args, context) {
      if (args.trim() && args.trim() !== "ycode") {
        context.ui.notify("Usage: /unload ycode", "error");
        return;
      }
      enabled = false;
      context.abort();
      try {
        controller.pauseRun("Ycode unloaded; resume explicitly");
        await context.waitForIdle();
        await dispose();
      } finally {
        restoreTools();
        context.ui.setStatus("roles", undefined);
      }
      context.ui.notify("Ycode disabled for this session. /reload to enable it again.", "info");
    },
  });
  return { active, enabled: () => enabled };
}
