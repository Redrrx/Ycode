import { eq } from "drizzle-orm";
import { taskSchema } from "../workflow/protocol.ts";
import { encode } from "./database.ts";
import { taskSummary } from "./report.ts";
import type { ProjectTask } from "./schema.ts";
import { tables } from "./tables.ts";
import type { TaskStore } from "./tasks.ts";
type Verdict = "accept" | "revise" | "stop";

export function reviewWork(
  state: TaskStore,
  id: string,
  verdict: Verdict,
  reason: string,
  revision: number,
): void {
  const task = state.get(id);
  if (!task) {
    throw new Error("Review requires a task ID, not a milestone ID");
  }
  if (revision !== task.revision) {
    throw new Error("Task review requires the returned revision");
  }
  reviewTask(state, task, verdict, reason);
}

function reviewTask(state: TaskStore, task: ProjectTask, verdict: Verdict, reason: string): void {
  if (!["finished", "blocked", "interrupted"].includes(task.status)) {
    throw new Error("Task is not awaiting review");
  }
  if (verdict === "accept" && (task.status !== "finished" || !state.passed(task))) {
    throw new Error("Acceptance requires a finished task with every criterion passed");
  }
  const database = state.database;
  if (verdict === "revise") {
    const previous = taskSummary(task);
    const spec = taskSchema.parse({
      ...task.spec,
      previousAnswer: "answer" in previous ? previous.answer : task.spec.previousAnswer,
      context: [task.spec.context, `Revision: ${reason}`].filter(Boolean).join("\n"),
    });
    database.orm
      .update(tables.tasks)
      .set({ revision: task.revision + 1, status: "ready", spec: encode(spec), result: null })
      .where(eq(tables.tasks.id, task.id))
      .run();
  } else {
    database.orm
      .update(tables.tasks)
      .set({ status: verdict === "accept" ? "accepted" : "stopped" })
      .where(eq(tables.tasks.id, task.id))
      .run();
  }
  state.refresh(task.milestone);
  database.event("task_review", task.id, { revision: task.revision, verdict, reason });
}
