import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import { SESSION_ENTRIES } from "../config/constants.ts";
import { parseProjectAction } from "../project/schema.ts";
import { mainPrompt, reviewPrompt } from "../prompts.ts";
import type { WorkflowController } from "../workflow/controller.ts";
import { stripWorkflow } from "../workflow/protocol.ts";
export function mainResponseText(text: string, reviewing = false): string {
  if (!text.includes("<workflow>") && !text.includes("</workflow>")) {
    return reviewing ? "" : stripWorkflow(text);
  }
  try {
    const directive = parseProjectAction(text);
    if (!directive) {
      return "";
    }
    if (directive.action === "project_reply") {
      return directive.question ?? "";
    }
    return ["task", "run", "start_run", "resume_run", "clarify"].includes(directive.action)
      ? "I’ll have Worker handle this."
      : "";
  } catch {
    return "";
  }
}

export function mainResponse(message: AssistantMessage, reviewing: boolean): AssistantMessage {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return {
    ...message,
    content: [
      ...message.content.filter((block) => block.type !== "text"),
      {
        type: "text",
        text:
          message.stopReason === "error" || message.stopReason === "aborted"
            ? ""
            : mainResponseText(text, reviewing),
      },
    ],
  };
}

export function reportSetupError(pi: ExtensionAPI, error: unknown): void {
  pi.sendMessage({
    customType: SESSION_ENTRIES.setupError,
    content: error instanceof Error ? error.message : String(error),
    display: true,
  });
}

function stateSections(
  sections: Record<string, string | null> | undefined,
  project: unknown,
  review: string,
) {
  const result = { ...sections };
  delete result.project_state;
  delete result.worker_review;
  if (project) {
    result.project_state = JSON.stringify(project);
  }
  if (review) {
    result.worker_review = review;
  }
  return result;
}

export function registerMainGuards(pi: ExtensionAPI, controller: WorkflowController): void {
  pi.on("before_agent_start", (event) => {
    pi.setActiveTools([]);
    controller.startRequest();

    event.systemPromptOptions.customPrompt = mainPrompt();
    event.systemPromptOptions.forceSystemPrompt = undefined;
    event.systemPromptOptions.selectedTools = [];
  });
  pi.on("context_with_system", (event) => {
    const lastSystem = event.messages.findLastIndex((message) => message.role === "system");
    const lastResult = event.messages.findLastIndex(
      (message) =>
        message.role === "custom" &&
        message.customType === SESSION_ENTRIES.workerResult &&
        z.string().safeParse(message.content).data?.startsWith("Worker result"),
    );
    const revision = controller.getProjectRevision();
    const lastState = event.messages.findLastIndex(
      (message) =>
        message.role === "custom" &&
        message.customType === SESSION_ENTRIES.workflowState &&
        revision !== undefined &&
        z.object({ stateRevision: z.number() }).safeParse(message.details).data?.stateRevision ===
          revision,
    );
    const snapshot = controller.getProjectSnapshot();
    return {
      messages: event.messages
        .map((message, index) =>
          message.role === "system"
            ? {
                ...message,
                toolsAdded: [],
                toolsRemoved: [],
                sections: stateSections(
                  message.sections,
                  index === lastSystem ? snapshot : undefined,
                  index === lastSystem ? reviewPrompt(controller.getPendingReview()) : "",
                ),
              }
            : message,
        )
        .filter(
          (message, index) =>
            message.role !== "custom" ||
            ((message.customType !== SESSION_ENTRIES.workerResult || index === lastResult) &&
              (message.customType !== SESSION_ENTRIES.workflowState || index === lastState)),
        ),
    };
  });
  pi.on("tool_call", () => ({
    block: true,
    reason: "Main is tool-free. Delegate repository work through the workflow protocol.",
  }));
}
