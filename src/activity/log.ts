import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { ACTIVITY_LIMITS } from "../config/constants.ts";
import { activityDetail, activityTitle } from "./data.ts";
import {
  ACTIVITY_ENTRY,
  activityEventSchema,
  type ActivityEvent,
  type ActivityFinish,
  type ActivityRecord,
  type ActivityStart,
  type ActivityStatus,
} from "./types.ts";
export function recordReview(
  log: ActivityLog,
  id: string,
  verdict: "accept" | "revise" | "stop",
  model?: string,
  input?: unknown,
): void {
  log.note(
    {
      runId: randomUUID(),
      taskId: id,
      actor: "main",
      kind: "review",
      model,
      title: `Review → ${verdict}`,
      input,
    },
    { status: verdict === "accept" ? "success" : "warning" },
  );
}

interface ActivityLogData {
  readonly pi: ExtensionAPI;
  readonly records: Map<string, ActivityRecord>;
  closed: boolean;
  restoreError: string | undefined;
  history: ((event: ActivityEvent, raw: unknown) => void) | undefined;
}

export type ActivityLog = Omit<
  ReturnType<typeof bindActivityLog>,
  "pi" | "records" | "closed" | "restoreError"
>;

export function createActivityLog(pi: ExtensionAPI): ActivityLog {
  return bindActivityLog({
    pi,
    records: new Map<string, ActivityRecord>(),
    closed: false,
    restoreError: undefined,
    history: undefined,
  });
}

function bindActivityLog(self: ActivityLogData) {
  return Object.assign(self, {
    assertReady: activityLogAssertReady.bind(undefined, self),
    getEntries: activityLogGetEntries.bind(undefined, self),
    get: activityLogGet.bind(undefined, self),
    latestTask: activityLogLatestTask.bind(undefined, self),
    depth: activityLogDepth.bind(undefined, self),
    start: activityLogStart.bind(undefined, self),
    finish: activityLogFinish.bind(undefined, self),
    note: activityLogNote.bind(undefined, self),
    closeRun: activityLogCloseRun.bind(undefined, self),
    restore: activityLogRestore.bind(undefined, self),
    dispose: activityLogDispose.bind(undefined, self),
  });
}

function activityLogAssertReady(self: ActivityLogData): void {
  if (self.restoreError) {
    throw new Error(self.restoreError);
  }
}

function activityLogGetEntries(self: ActivityLogData): readonly ActivityRecord[] {
  activityLogAssertReady(self);
  return [...self.records.values()];
}

function activityLogGet(self: ActivityLogData, id: string): ActivityRecord | undefined {
  return self.records.get(id);
}

function activityLogLatestTask(self: ActivityLogData, taskId: string): ActivityRecord | undefined {
  return [...self.records.values()].findLast(
    (record) => record.kind === "task" && record.taskId === taskId,
  );
}

function activityLogDepth(self: ActivityLogData, record: ActivityRecord): number {
  let depth = 0;
  let parentId = record.parentId;
  while (parentId && depth < ACTIVITY_LIMITS.nestingDepth) {
    depth++;
    parentId = self.records.get(parentId)?.parentId;
  }
  return depth;
}

function activityLogStart(self: ActivityLogData, input: ActivityStart): string {
  const id = randomUUID();
  const record: ActivityRecord = {
    ...input,
    id,
    status: "running",
    title: activityTitle(input.title),
    startedAt: Date.now(),
    input: input.input === undefined ? undefined : activityDetail(input.input),
  };
  activityLogWrite(self, { version: 2, event: "start", record }, input.input);
  return id;
}

function activityLogFinish(
  self: ActivityLogData,
  id: string,
  result: ActivityFinish,
  recordHistory = true,
): void {
  const record = self.records.get(id);
  if (!record || record.status !== "running") {
    return;
  }
  activityLogWrite(
    self,
    {
      version: 2,
      event: "finish",
      update: {
        id,
        status: result.status,
        endedAt: Date.now(),
        title: result.title === undefined ? record.title : activityTitle(result.title),
        output: result.output === undefined ? undefined : activityDetail(result.output),
        usage: result.usage,
      },
    },
    result.output,
    recordHistory,
  );
}

function activityLogNote(
  self: ActivityLogData,
  input: ActivityStart,
  result: ActivityFinish,
): void {
  activityLogFinish(self, activityLogStart(self, input), result);
}

function activityLogCloseRun(self: ActivityLogData, runId: string, status: ActivityStatus): void {
  for (const record of self.records.values()) {
    if (record.runId === runId && record.status === "running") {
      activityLogFinish(self, record.id, {
        status,
        output: "The task ended before this operation recorded a completion.",
      });
    }
  }
}

function activityLogRestore(self: ActivityLogData, context: ExtensionContext): void {
  self.records.clear();
  self.restoreError = undefined;
  const events: ActivityEvent[] = [];
  for (const entry of context.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ACTIVITY_ENTRY) {
      continue;
    }
    const parsed = activityEventSchema.safeParse(entry.data);
    if (!parsed.success) {
      self.restoreError =
        "Unsupported or invalid Ycode activity format. Start a new session or use the matching Ycode version. Stored history was not changed.";
      throw new Error(self.restoreError);
    }
    events.push(parsed.data);
  }
  events.forEach((event) => activityLogApply(self, event));

  for (const record of self.records.values()) {
    if (record.status === "running") {
      activityLogFinish(
        self,
        record.id,
        {
          status: "interrupted",
          output: "No completion was recorded on this session branch before it was reopened.",
        },
        false,
      );
    }
  }
}

function activityLogDispose(self: ActivityLogData): void {
  for (const record of self.records.values()) {
    if (record.status === "running") {
      activityLogFinish(self, record.id, {
        status: "interrupted",
        output: "Session closed during execution.",
      });
    }
  }
  self.closed = true;
}

function activityLogWrite(
  self: ActivityLogData,
  event: ActivityEvent,
  raw?: unknown,
  recordHistory = true,
): void {
  if (self.closed) {
    return;
  }
  if (recordHistory) {
    self.history?.(event, raw);
  }
  activityLogApply(self, event);
  self.pi.appendEntry(ACTIVITY_ENTRY, event);
}

function activityLogApply(self: ActivityLogData, event: ActivityEvent): void {
  if (event.event === "start") {
    self.records.set(event.record.id, event.record);
    return;
  }
  const previous = self.records.get(event.update.id);
  if (previous) {
    self.records.set(previous.id, { ...previous, ...event.update });
  }
}
