import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { z } from "zod";
export const INPUT_LIMITS = {
  pathChars: 1000,
  targetChars: 1000,
  textChars: 8000,
  listItems: 20,
  taskIdChars: 64,
} as const;

export const DECISION_LIMITS = {
  candidates: 12,
  probabilityTolerance: 0.05,
} as const;

export const EXPLORATION_LIMITS = {
  workspacePreviews: 4,
  batch: DECISION_LIMITS.candidates,
  findingsPerCall: 4,
  searchResults: 3,
  subtreePreview: 6,
  workspaceSummaryChars: 600,
  workspaceSourcePaths: 4,
  declarationsReturned: 24,
  excerptChars: 6000,
  referenceCount: 12,
  treeChars: 6000,
  warnings: 16,
  outputBytes: 24 * 1024,
  deadlineMs: 120_000,
} as const;

export const MUTATION_LIMITS = {
  inputBytes: 48 * 1024,
  replacementChars: 12000,
  replacements: 8,
  newFileChars: 32000,
  deadlineMs: 120_000,
} as const;

export const REPOSITORY_LIMITS = {
  commandTimeoutMs: 15_000,
  commandOutputBytes: 2 * 1024 * 1024,
  sourceFileBytes: 256 * 1024,
  sourceFiles: 20_000,
  directoryPreviewChildren: 24,
  directoryPreviewChars: 2400,
} as const;

export const WORKER_LIMITS = {
  notesChars: 6000,
  providerRetries: 1,
} as const;

export const SUMMARIZER_LIMITS = {
  providerRetries: 1,
  retryDelayMs: 2000,
  contextMargin: 1024,
  minimumOutput: 1024,
} as const;

export const WORKFLOW_LIMITS = {
  protocolRepairs: 2,
  errorChars: 500,
  reportBytes: 28 * 1024,
} as const;

export const REPORT_LIMITS = {
  summaryBytes: 12000,
  operationChars: 1800,
  recentOperations: 8,
  reportItemChars: 1200,
} as const;

export const ACTIVITY_LIMITS = {
  detailBytes: 64 * 1024,
  titleChars: 240,
  detailLines: 10,
  nestingDepth: 3,
  pickerRecords: 100,
} as const;

export const USAGE_LIMITS = {
  displayedWorkerTurns: 24,
} as const;

export const effortSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type WorkerEffort = z.infer<typeof effortSchema>;

export function requireEffort(
  role: string,
  model: Model<Api>,
  selected?: WorkerEffort,
): WorkerEffort {
  const levels = getSupportedThinkingLevels(model);
  if (!selected || !levels.includes(selected)) {
    throw new Error(`Set /${role} effort to one of: ${levels.join(", ")}.`);
  }
  return selected;
}

export const STORAGE_DIRECTORY = "perspi";

export const SESSION_ENTRIES = {
  workflowState: "workflow-state",
  workspace: "workspace-index-record",
  review: "task-review",
  workerResult: "worker-result",
  correction: "workflow-correction",
  paused: "workflow-paused",
  setupError: "workflow-setup-error",
  activity: "agent-activity",
  usage: "role-usage-report",
  usageObservation: "role-usage-observation",
} as const;

export const TOOL_NAMES = {
  overview: "workspace_overview",
  find: "find_code",
  inspect: "code_inspect",
  edit: "apply_edit",
  create: "create_file",
  directories: "create_directories",
  command: "run_command",
  process: "process_control",
  finish: "finish_task",
} as const;
