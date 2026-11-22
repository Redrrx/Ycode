import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { EXPLORATION_LIMITS as LIMITS } from "../../config/constants.ts";
import { inside } from "../../repository/tree.ts";
export const workspaceRecordSchema = z
  .object({
    id: z.string().uuid(),
    workspace: z.string(),
    root: z.string(),
    summary: z.string().max(LIMITS.workspaceSummaryChars),
    sourcePaths: z.array(z.string()).max(LIMITS.workspaceSourcePaths),
    stale: z.boolean(),
  })
  .refine(
    (record) =>
      isAbsolute(record.workspace) &&
      isAbsolute(record.root) &&
      inside(record.workspace, record.root) &&
      record.sourcePaths.every((path) => inside(record.root, resolve(record.workspace, path))),
    "Workspace index path outside its root",
  );
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;

interface WorkspaceIndexData {
  readonly records: Map<
    string,
    {
      id: string;
      workspace: string;
      root: string;
      summary: string;
      sourcePaths: string[];
      stale: boolean;
    }
  >;
  readonly save: (record: WorkspaceRecord) => void;
}

export type WorkspaceIndex = Omit<ReturnType<typeof bindWorkspaceIndex>, "records" | "save">;

export function createWorkspaceIndex(
  records: WorkspaceRecord[] = [],
  save: (record: WorkspaceRecord) => void = () => undefined,
): WorkspaceIndex {
  const initialRecords: Map<
    string,
    {
      id: string;
      workspace: string;
      root: string;
      summary: string;
      sourcePaths: string[];
      stale: boolean;
    }
  > = new Map<string, WorkspaceRecord>();

  for (const record of records) {
    initialRecords.set(record.id, workspaceRecordSchema.parse(record));
  }

  return bindWorkspaceIndex({ records: initialRecords, save });
}

function bindWorkspaceIndex(self: WorkspaceIndexData) {
  return Object.assign(self, {
    get: workspaceIndexGet.bind(undefined, self),
    list: workspaceIndexList.bind(undefined, self),
    put: workspaceIndexPut.bind(undefined, self),
    changed: workspaceIndexChanged.bind(undefined, self),
  });
}

function workspaceIndexGet(self: WorkspaceIndexData, id: string): WorkspaceRecord | undefined {
  const record = self.records.get(id);
  return record ? structuredClone(record) : undefined;
}

function workspaceIndexList(self: WorkspaceIndexData): WorkspaceRecord[] {
  return structuredClone([...self.records.values()]);
}

function workspaceIndexPut(self: WorkspaceIndexData, record: WorkspaceRecord): void {
  const parsed = workspaceRecordSchema.parse(record);
  if (JSON.stringify(self.records.get(parsed.id)) === JSON.stringify(parsed)) {
    return;
  }
  self.save(structuredClone(parsed));
  self.records.set(parsed.id, parsed);
}

function workspaceIndexChanged(self: WorkspaceIndexData, path: string): void {
  for (const record of self.records.values()) {
    if (inside(record.root, path) && !record.stale) {
      workspaceIndexPut(self, { ...record, stale: true });
    }
  }
}
