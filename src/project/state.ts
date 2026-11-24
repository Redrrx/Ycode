import { desc } from "drizzle-orm";
import type { z } from "zod";
import { serializeTask } from "../prompts.ts";
import { taskSummary } from "./report.ts";
import { readRun, runSummary } from "./run.ts";
import type { ProjectMilestone, ProjectTask, stateRequestSchema } from "./schema.ts";
import { serializeCheck } from "./schema.ts";
import { tables } from "./tables.ts";
import type { TaskStore } from "./tasks.ts";
import { createVerificationStore } from "./verification.ts";
import type { WorkspaceFacts } from "./workspace.ts";
const PAGE_SIZE = 8;
const active = (task: ProjectTask) => !["accepted", "stopped"].includes(task.status);
const present = <T>(items: T[]) => (items.length ? items : undefined);

function projectedStatus(task: ProjectTask, blockers: string[]): string {
  if (task.status === "ready" && blockers.length) {
    return "blocked";
  }
  return task.status === "finished" ? "review" : task.status;
}

interface ProjectStateData {
  readonly tasks: TaskStore;
}

export type ProjectState = Omit<ReturnType<typeof bindProjectState>, "tasks">;

export function createProjectState(tasks: TaskStore): ProjectState {
  return bindProjectState({ tasks });
}

function bindProjectState(self: ProjectStateData) {
  return Object.assign(self, {
    revision: projectStateRevision.bind(undefined, self),
    snapshot: projectStateSnapshot.bind(undefined, self),
    inspect: projectStateInspect.bind(undefined, self),
  });
}

function projectStateRevision(self: ProjectStateData): number {
  return (
    self.tasks.database.orm
      .select({ revision: tables.history.seq })
      .from(tables.history)
      .orderBy(desc(tables.history.seq))
      .limit(1)
      .get()?.revision ?? 0
  );
}

function projectStateHeader(self: ProjectStateData, task: ProjectTask) {
  const blockedBy = self.tasks.dependencies().blockers(task);
  return {
    id: task.id,
    revision: task.revision,
    status: projectedStatus(task, blockedBy),
    objective:
      task.spec.objective.length > 160
        ? `${task.spec.objective.slice(0, 160)}…`
        : task.spec.objective,
    blockedBy: active(task) && blockedBy.length ? blockedBy : undefined,
  };
}

function projectStateSnapshot(self: ProjectStateData, workspace?: WorkspaceFacts) {
  const current = self.tasks.selected();
  const selected = current && active(current) ? current : undefined;
  const tasks = self.tasks.tasks();
  const open = tasks.filter((task) => active(task) && task.spec.kind !== "investigation");
  const constraints = self.tasks.database.constraints();
  const checks = createVerificationStore(self.tasks.database).summary();
  const pending = tasks.filter((task) => task.status === "finished");
  const goal = self.tasks.database.goal() || undefined;
  return {
    revision: projectStateRevision(self),
    workspace,
    hasSavedWork: Boolean(
      goal ||
      tasks.length ||
      self.tasks.database.orm
        .select({ id: tables.milestones.id })
        .from(tables.milestones)
        .limit(1)
        .get(),
    ),
    run: runSummary(self.tasks),
    goal,
    constraints: present(constraints),
    selected: selected ? projectStateHeader(self, selected) : undefined,
    review: present(
      pending.slice(0, PAGE_SIZE).map((task) => ({ id: task.id, revision: task.revision })),
    ),
    reviewRemaining: pending.length > PAGE_SIZE ? pending.length - PAGE_SIZE : undefined,
    backlog: open.length || undefined,
    tasks: selected
      ? undefined
      : present(open.slice(0, PAGE_SIZE).map((task) => projectStateHeader(self, task))),
    checks: present(checks),
  };
}

function projectStateInspect(self: ProjectStateData, request: z.infer<typeof stateRequestSchema>) {
  const revision = projectStateRevision(self);
  if (request.offset && request.revision === undefined) {
    throw new Error("Paging requires the returned revision");
  }
  if (request.revision !== undefined && request.revision !== revision) {
    throw new Error("Project state changed; restart paging");
  }
  if (request.id) {
    const run = readRun(self.tasks.database);
    if (run?.id === request.id) {
      return {
        revision,
        run: runSummary(self.tasks),
        ...projectStatePage(
          self,
          run.tasks.flatMap((item) => self.tasks.get(item.id) ?? []),
          request.offset,
        ),
      };
    }
    const task = self.tasks.get(request.id);
    if (task) {
      return {
        ...projectStateHeader(self, task),
        ...serializeTask(task.spec),
        milestone: task.milestone,
        kind: task.spec.kind,
        dependsOn: present(task.spec.dependsOn ?? []),
        result: task.result ? taskSummary(task) : undefined,
      };
    }
    const milestone = self.tasks.milestones().find((item) => item.id === request.id);
    if (!milestone) {
      throw new Error(`Unknown work: ${request.id}`);
    }
    return {
      revision,
      milestone: projectStateMilestoneHeader(self, milestone),
      ...projectStatePage(self, self.tasks.tasks(milestone.id), request.offset),
    };
  }
  return {
    revision,
    run: runSummary(self.tasks),
    ...projectStatePage(self, self.tasks.tasks().filter(active), request.offset),
    checks: present(createVerificationStore(self.tasks.database).definitions().map(serializeCheck)),
  };
}

function projectStateMilestoneHeader(self: ProjectStateData, milestone: ProjectMilestone) {
  const accepted = new Set(
    self.tasks
      .milestones()
      .filter((item) => item.status === "accepted")
      .map((item) => item.id),
  );
  const blockedBy = milestone.dependencies.filter((id) => !accepted.has(id));
  return {
    id: milestone.id,
    objective: milestone.objective,
    status: milestone.status === "ready" && blockedBy.length ? "blocked" : milestone.status,
    dependsOn: present(milestone.dependencies),
    blockedBy: present(blockedBy),
  };
}

function projectStatePage(self: ProjectStateData, tasks: ProjectTask[], offset = 0) {
  if (offset > tasks.length) {
    throw new Error("Invalid state offset");
  }
  const items = tasks
    .slice(offset, offset + PAGE_SIZE)
    .map((task) => projectStateHeader(self, task));
  return {
    tasks: present(items),
    nextOffset: offset + items.length < tasks.length ? offset + items.length : undefined,
  };
}
