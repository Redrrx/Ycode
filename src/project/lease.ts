import { and, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ProjectDatabase } from "./database.ts";
import { tables } from "./tables.ts";
import { createVerificationStore } from "./verification.ts";
const leaseSchema = z.object({ owner: z.string(), pid: z.number() });

function processStamp(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8");
    return createHash("sha256").update(`${boot}:${start}`).digest("hex");
  } catch {
    return undefined;
  }
}

interface ExecutionLeaseData {
  readonly owner: string;
  readonly database: ProjectDatabase;
}

export type ExecutionLease = Pick<ReturnType<typeof bindExecutionLease>, "acquire" | "release">;

export function createExecutionLease(database: ProjectDatabase): ExecutionLease {
  const owner: string = `${processStamp(process.pid) ?? "unknown"}/${randomUUID()}`;

  return bindExecutionLease({ owner, database });
}

function bindExecutionLease(self: ExecutionLeaseData) {
  return Object.assign(self, {
    acquire: executionLeaseAcquire.bind(undefined, self),
    release: executionLeaseRelease.bind(undefined, self),
  });
}

function assertOwnerExited(previous: z.infer<typeof leaseSchema>): void {
  let alive = true;
  try {
    process.kill(previous.pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      alive = false;
    }
  }
  const stamp = processStamp(previous.pid);
  const saved = previous.owner.split("/")[0];
  const reused = stamp && saved && /^[a-f0-9]{64}$/u.test(saved) && saved !== stamp;
  if (alive && !reused) {
    throw new Error("Another session is executing this project; no work was started");
  }
}

function executionLeaseAcquire(self: ExecutionLeaseData): void {
  self.database.transaction(() => {
    const row = self.database.orm.select().from(tables.lease).where(eq(tables.lease.id, 1)).get();
    if (row) {
      const previous = leaseSchema.parse(row);
      if (previous.owner === self.owner) {
        return;
      }
      assertOwnerExited(previous);
    }
    self.database.orm
      .insert(tables.lease)
      .values({ id: 1, owner: self.owner, pid: process.pid })
      .onConflictDoUpdate({
        target: tables.lease.id,
        set: { owner: self.owner, pid: process.pid },
      })
      .run();
    self.database.orm
      .update(tables.tasks)
      .set({ status: "interrupted" })
      .where(eq(tables.tasks.status, "running"))
      .run();
    self.database.orm
      .update(tables.milestones)
      .set({ status: "blocked" })
      .where(eq(tables.milestones.status, "running"))
      .run();
    self.database.orm
      .update(tables.checkResults)
      .set({ status: "interrupted" })
      .where(eq(tables.checkResults.status, "running"))
      .run();
    if (
      self.database.orm
        .select({ id: tables.commands.id })
        .from(tables.commands)
        .where(eq(tables.commands.status, "running"))
        .limit(1)
        .get()
    ) {
      createVerificationStore(self.database).invalidate();
    }
    self.database.orm
      .update(tables.commands)
      .set({ ended: Date.now(), status: "interrupted" })
      .where(eq(tables.commands.status, "running"))
      .run();
    self.database.orm
      .update(tables.activity)
      .set({ ended: Date.now(), status: "interrupted" })
      .where(eq(tables.activity.status, "running"))
      .run();
  });
}

function executionLeaseRelease(self: ExecutionLeaseData): void {
  self.database.orm
    .delete(tables.lease)
    .where(and(eq(tables.lease.id, 1), eq(tables.lease.owner, self.owner)))
    .run();
}
