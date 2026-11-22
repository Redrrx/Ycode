import { eq } from "drizzle-orm";
import { encode } from "./database.ts";
import { openRun } from "./run.ts";
import { projectPlanSchema, type ProjectPlan, type ProjectTask } from "./schema.ts";
import { tables } from "./tables.ts";
import type { TaskStore } from "./tasks.ts";
import { createVerificationStore } from "./verification.ts";
export function savePlan(state: TaskStore, input: ProjectPlan): void {
  const plan = projectPlanSchema.parse(input);
  const database = state.database;
  database.transaction(() => {
    if (openRun(database)) {
      throw new Error("Cancel the active run before changing the plan");
    }
    database.orm.insert(tables.project).values({ id: 1, goal: "" }).onConflictDoNothing().run();
    if (plan.goal !== undefined) {
      database.orm
        .update(tables.project)
        .set({ goal: plan.goal })
        .where(eq(tables.project.id, 1))
        .run();
    }
    if (plan.constraints !== undefined) {
      database.orm
        .update(tables.project)
        .set({ constraints: encode(plan.constraints) })
        .where(eq(tables.project.id, 1))
        .run();
    }
    if (plan.checks !== undefined) {
      createVerificationStore(database).define(plan.checks);
    }
    for (const milestone of plan.milestones) {
      saveMilestone(state, milestone);
    }
    state.dependencies().validate();
    database.event("plan", "project", plan);
  });
}

function saveMilestone(state: TaskStore, milestone: ProjectPlan["milestones"][number]): void {
  const database = state.database;
  const previous = state.milestones().find((item) => item.id === milestone.id);
  if (previous && ["accepted", "stopped"].includes(previous.status)) {
    throw new Error("Closed milestones are immutable; add a new milestone");
  }
  const dependencies = milestone.dependsOn ?? previous?.dependencies ?? [];
  if (
    previous &&
    encode(dependencies) !== encode(previous.dependencies) &&
    state.tasks(milestone.id).some((task) => task.status !== "ready")
  ) {
    throw new Error(
      "Milestone prerequisites cannot change after work starts; revise individual unfinished tasks instead",
    );
  }
  database.orm
    .insert(tables.milestones)
    .values({
      id: milestone.id,
      objective: milestone.objective,
      status: "ready",
      dependencies: encode(dependencies),
    })
    .onConflictDoUpdate({
      target: tables.milestones.id,
      set: { objective: milestone.objective, dependencies: encode(dependencies) },
    })
    .run();
  for (const spec of milestone.tasks) {
    saveTask(state, milestone.id, spec);
  }
  const listed = milestone.tasks.map((task) => task.id);
  const omitted = state
    .tasks(milestone.id)
    .map((task) => task.id)
    .filter((id) => !listed.includes(id));
  [...listed, ...omitted].forEach((id, position) => {
    database.orm.update(tables.tasks).set({ position }).where(eq(tables.tasks.id, id)).run();
  });
  state.refresh(milestone.id);
}

function taskSpec(input: ProjectTask["spec"], previous?: ProjectTask) {
  const spec = {
    ...input,
    kind: input.kind ?? previous?.spec.kind ?? "change",
    dependsOn: input.dependsOn ?? previous?.spec.dependsOn,
  };
  if (spec.kind === "investigation" && spec.mode === "edit") {
    throw new Error("Investigation requires read-only mode");
  }
  return spec;
}

function saveTask(
  state: TaskStore,
  milestone: string,
  input: ProjectPlan["milestones"][number]["tasks"][number],
): void {
  const previous = state.get(input.id);
  if (previous && previous.milestone !== milestone) {
    throw new Error("Task IDs cannot move between milestones");
  }
  const spec = taskSpec(input, previous);
  if (previous && encode(previous.spec) === encode(spec)) {
    return;
  }
  if (previous && ["accepted", "stopped", "running"].includes(previous.status)) {
    throw new Error("Running or closed tasks cannot be revised");
  }
  const revision = (previous?.revision ?? 0) + 1;
  state.database.orm
    .insert(tables.tasks)
    .values({ id: spec.id, milestone, revision, spec: encode(spec), status: "ready" })
    .onConflictDoUpdate({
      target: tables.tasks.id,
      set: { revision, spec: encode(spec), status: "ready", result: null },
    })
    .run();
  state.database.event("task_revision", spec.id, { revision, spec });
}
