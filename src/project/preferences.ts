import { eq } from "drizzle-orm";
import { z } from "zod";
import { effortSchema, type WorkerEffort } from "../config/constants.ts";
import type { ProjectDatabase } from "./database.ts";
import { tables } from "./tables.ts";
interface PreferenceStoreData {
  readonly database: ProjectDatabase;
}

export type PreferenceStore = Omit<ReturnType<typeof bindPreferenceStore>, "database">;

export function createPreferenceStore(database: ProjectDatabase): PreferenceStore {
  return bindPreferenceStore({ database });
}

function bindPreferenceStore(self: PreferenceStoreData) {
  return Object.assign(self, {
    workerEffort: preferenceStoreWorkerEffort.bind(undefined, self),
    summarizerEffort: preferenceStoreSummarizerEffort.bind(undefined, self),
    setSummarizerEffort: preferenceStoreSetSummarizerEffort.bind(undefined, self),
    setWorkerEffort: preferenceStoreSetWorkerEffort.bind(undefined, self),
  });
}

function preferenceStoreWorkerEffort(self: PreferenceStoreData): WorkerEffort | undefined {
  return preferenceStoreEffort(self, "worker");
}

function preferenceStoreSummarizerEffort(self: PreferenceStoreData): WorkerEffort | undefined {
  return preferenceStoreEffort(self, "summarizer");
}

function preferenceStoreSetSummarizerEffort(
  self: PreferenceStoreData,
  effort: WorkerEffort | undefined,
): void {
  preferenceStoreSetEffort(self, "summarizer", effort);
}

function preferenceStoreEffort(
  self: PreferenceStoreData,
  role: "worker" | "summarizer",
): WorkerEffort | undefined {
  const row = self.database.orm
    .select()
    .from(tables.preferences)
    .where(eq(tables.preferences.key, `${role}.effort`))
    .get();
  return row ? effortSchema.parse(z.object({ value: z.string() }).parse(row).value) : undefined;
}

function preferenceStoreSetWorkerEffort(
  self: PreferenceStoreData,
  effort: WorkerEffort | undefined,
): void {
  preferenceStoreSetEffort(self, "worker", effort);
}

function preferenceStoreSetEffort(
  self: PreferenceStoreData,
  role: "worker" | "summarizer",
  effort: WorkerEffort | undefined,
): void {
  const key = `${role}.effort`;
  self.database.transaction(() => {
    if (effort === undefined) {
      self.database.orm.delete(tables.preferences).where(eq(tables.preferences.key, key)).run();
    } else {
      const value = effortSchema.parse(effort);
      self.database.orm
        .insert(tables.preferences)
        .values({ key, value })
        .onConflictDoUpdate({ target: tables.preferences.key, set: { value } })
        .run();
    }
    self.database.event("preference", key, { effort: effort ?? "default" });
  });
}
