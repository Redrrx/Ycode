import type { ProjectMilestone, ProjectTask } from "./schema.ts";
interface DependencyGraphData {
  readonly tasks: Map<string, ProjectTask>;
  readonly milestones: Map<string, ProjectMilestone>;
}

export type DependencyGraph = Omit<ReturnType<typeof bindDependencyGraph>, "tasks" | "milestones">;

export function createDependencyGraph(
  tasks: ProjectTask[],
  milestones: ProjectMilestone[],
): DependencyGraph {
  return bindDependencyGraph({
    tasks: new Map(tasks.map((task) => [task.id, task])),
    milestones: new Map(milestones.map((milestone) => [milestone.id, milestone])),
  });
}

function bindDependencyGraph(self: DependencyGraphData) {
  return Object.assign(self, {
    validate: dependencyGraphValidate.bind(undefined, self),
    blockers: dependencyGraphBlockers.bind(undefined, self),
    prerequisites: dependencyGraphPrerequisites.bind(undefined, self),
  });
}

function dependencyGraphValidate(self: DependencyGraphData): void {
  const edges = new Map<string, string[]>();
  for (const milestone of self.milestones.values()) {
    if (self.tasks.has(milestone.id)) {
      throw new Error(`Duplicate work ID: ${milestone.id}`);
    }
    dependencyGraphRequire(milestone.dependencies, self.milestones);
    edges.set(milestone.id, [
      ...milestone.dependencies,
      ...dependencyGraphMembers(self, milestone.id),
    ]);
  }
  for (const task of self.tasks.values()) {
    const dependencies = task.spec.dependsOn ?? [];
    dependencyGraphRequire(dependencies, self.tasks);
    const milestone = self.milestones.get(task.milestone);
    if (!milestone) {
      throw new Error(`Missing milestone: ${task.milestone}`);
    }
    edges.set(task.id, [...dependencies, ...milestone.dependencies]);
  }
  assertAcyclic(edges);
}

function dependencyGraphRequire(ids: string[], records: ReadonlyMap<string, unknown>): void {
  for (const id of ids) {
    if (!records.has(id)) {
      throw new Error(`Unknown prerequisite: ${id}`);
    }
  }
}

function dependencyGraphMembers(self: DependencyGraphData, id: string): string[] {
  return [...self.tasks.values()].filter((task) => task.milestone === id).map((task) => task.id);
}

function dependencyGraphBlockers(self: DependencyGraphData, task: ProjectTask): string[] {
  const milestone = self.milestones.get(task.milestone);
  const tasks = (task.spec.dependsOn ?? []).filter(
    (id) => self.tasks.get(id)?.status !== "accepted",
  );
  const milestones = (milestone?.dependencies ?? []).filter(
    (id) => self.milestones.get(id)?.status !== "accepted",
  );
  return [...tasks, ...milestones];
}

function dependencyGraphPrerequisites(self: DependencyGraphData, task: ProjectTask): ProjectTask[] {
  const milestones = self.milestones.get(task.milestone)?.dependencies ?? [];
  const ids = new Set([
    ...(task.spec.dependsOn ?? []),
    ...milestones.flatMap((id) => dependencyGraphMembers(self, id)),
  ]);
  return [...self.tasks.values()].filter((item) => ids.has(item.id));
}

function assertAcyclic(edges: Map<string, string[]>): void {
  const remaining = new Map(
    [...edges].map(([id, dependencies]) => [id, new Set(dependencies).size]),
  );
  const dependents = new Map<string, string[]>();
  for (const [id, dependencies] of edges) {
    for (const dependency of new Set(dependencies)) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), id]);
    }
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < ready.length; index++) {
    for (const id of dependents.get(ready[index] ?? "") ?? []) {
      const count = (remaining.get(id) ?? 0) - 1;
      remaining.set(id, count);
      if (count === 0) {
        ready.push(id);
      }
    }
  }
  if (ready.length !== edges.size) {
    throw new Error("Dependency cycle; plan was not saved");
  }
}
