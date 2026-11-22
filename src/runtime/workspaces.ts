import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { SESSION_ENTRIES } from "../config/constants.ts";
import type { ProjectDatabase } from "../project/database.ts";
import { encode } from "../project/database.ts";
import { tables } from "../project/tables.ts";
import type { WorkspaceIndex } from "../tools/explore/workspace-index.ts";
import {
  createWorkspaceIndex,
  workspaceRecordSchema,
  type WorkspaceRecord,
} from "../tools/explore/workspace-index.ts";
const savedWorkspaceSchema = z.object({ version: z.literal(1), record: workspaceRecordSchema });

function sessionWorkspaces(context: ExtensionContext, cwd: string): WorkspaceRecord[] {
  const records = new Map<string, WorkspaceRecord>();
  for (const entry of context.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== SESSION_ENTRIES.workspace) {
      continue;
    }
    const saved = savedWorkspaceSchema.safeParse(entry.data);
    if (saved.success && saved.data.record.workspace === cwd) {
      records.set(saved.data.record.root, saved.data.record);
    }
  }
  return [...records.values()];
}

export async function taskWorkspaceIndex(
  context: ExtensionContext,
  pi: ExtensionAPI,
  project?: ProjectDatabase,
): Promise<WorkspaceIndex> {
  const cwd = await realpath(context.cwd);
  const records = project
    ? project.orm
        .select()
        .from(tables.workspaces)
        .all()
        .map((row) => {
          const value = z.object({ data: z.string() }).parse(row);
          return workspaceRecordSchema.parse(JSON.parse(value.data));
        })
    : [];
  if (records.length === 0) {
    records.push(...sessionWorkspaces(context, cwd));
  }
  if (project) {
    for (const record of records) {
      project.orm
        .insert(tables.workspaces)
        .values({ id: record.id, data: encode(record) })
        .onConflictDoNothing()
        .run();
    }
  }
  return createWorkspaceIndex(records, (record) => {
    if (project) {
      project.transaction(() => {
        project.orm
          .insert(tables.workspaces)
          .values({ id: record.id, data: encode(record) })
          .onConflictDoUpdate({ target: tables.workspaces.id, set: { data: encode(record) } })
          .run();
        project.event("workspace", record.id, record);
      });
    } else {
      pi.appendEntry(SESSION_ENTRIES.workspace, { version: 1, record });
    }
  });
}
