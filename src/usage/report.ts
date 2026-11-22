import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ActivityLog } from "../activity/log.ts";
import { buildUsageReport } from "./accounting.ts";
import { registerMainUsage } from "./observer.ts";
import { registerUsageRenderer } from "./renderer.ts";
import { USAGE_ENTRY } from "./schema.ts";
export function registerUsageReports(pi: ExtensionAPI, log: ActivityLog): void {
  registerMainUsage(pi);
  let requestStartedAt: number | undefined;
  pi.on("before_agent_start", () => {
    requestStartedAt ??= Date.now();
  });
  pi.on("agent_settled", (_event, context) => {
    if (requestStartedAt !== undefined) {
      pi.appendEntry(USAGE_ENTRY, buildUsageReport(context, log, requestStartedAt));
      requestStartedAt = undefined;
    }
  });
  pi.registerCommand("usage", {
    description: "Show session usage by role",
    handler: async (_args, context) => {
      pi.appendEntry(USAGE_ENTRY, buildUsageReport(context, log));
    },
  });
  registerUsageRenderer(pi);
}
