import { z } from "zod";
import { dependencyGraphSchema, parseWorkflow, taskSchema } from "../workflow/protocol.ts";
export const checkDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    command: z.string().min(1).max(12000),
    cwd: z.string().max(1000).default("."),
    network: z.boolean().default(false),
    writable: z.boolean().default(false),
  })
  .strict();
export type CheckDefinition = z.infer<typeof checkDefinitionSchema>;

export const projectPlanSchema = z
  .object({
    goal: z.string().trim().min(1).max(4000).optional(),
    checks: z.array(checkDefinitionSchema).optional(),
    constraints: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
    milestones: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[a-zA-Z0-9_-]+$/)
              .max(120),
            objective: z.string().trim().min(1).max(4000),
            dependsOn: dependencyGraphSchema.optional(),
            tasks: z.array(taskSchema).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((plan, context) => {
    const milestones = plan.milestones.map((milestone) => milestone.id);
    const tasks = plan.milestones.flatMap((milestone) => milestone.tasks.map((task) => task.id));
    if (new Set([...milestones, ...tasks]).size !== milestones.length + tasks.length) {
      context.addIssue({ code: "custom", message: "Milestone and task IDs must be unique" });
    }
  });

export const historyRequestSchema = z
  .object({
    query: z.string().min(1).max(500).optional(),
    changeId: z.string().min(1).max(120).optional(),
    view: z.enum(["summary", "mutation"]).optional(),
    path: z.string().min(1).max(1000).optional(),
    task: z.string().min(1).max(120).optional(),
    action: z.enum(["create", "edit", "mkdir"]).optional(),
    status: z.enum(["pending", "applied", "retryable", "conflict", "not_applied"]).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    cursor: z.string().min(1).max(6000).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export const reviewSchema = z
  .object({
    id: z.string(),
    revision: z.int().positive(),
    verdict: z.enum(["accept", "revise", "stop"]),
    reason: z.string().min(1).max(4000),
  })
  .strict();

export const stateRequestSchema = z
  .object({
    id: z.string().optional(),
    offset: z.int().nonnegative().optional(),
    revision: z.int().nonnegative().optional(),
  })
  .strict();

export const projectActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start_run"),
      tasks: dependencyGraphSchema.min(1),
      verification: z.string().min(1),
      revision: z.int().nonnegative(),
    })
    .strict(),
  z.object({ action: z.enum(["resume_run", "pause_run", "cancel_run"]) }).strict(),
  stateRequestSchema.extend({ action: z.literal("state") }),
  z.object({ action: z.literal("run"), id: z.string(), review: reviewSchema.optional() }).strict(),
  z
    .object({
      action: z.literal("task"),
      task: taskSchema.omit({ id: true }),
      review: reviewSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("clarify"),
      id: z.string(),
      question: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z.object({ action: z.literal("plan"), plan: projectPlanSchema }).strict(),
  z
    .object({
      action: z.literal("project_reply"),
      question: z.string().trim().min(1).max(4000).optional(),
      review: reviewSchema.optional(),
    })
    .strict(),
]);

export const taskRowSchema = z.object({
  id: z.string(),
  milestone: z.string(),
  revision: z.number(),
  status: z.enum(["ready", "running", "finished", "accepted", "blocked", "interrupted", "stopped"]),
  spec: z.string().transform((text) => taskSchema.parse(JSON.parse(text))),
  result: z.string().nullable(),
});
export type ProjectTask = z.infer<typeof taskRowSchema>;
export type ProjectPlan = z.infer<typeof projectPlanSchema>;
export const milestoneRowSchema = z.object({
  id: z.string(),
  objective: z.string(),
  dependencies: z.string().transform((text) => dependencyGraphSchema.parse(JSON.parse(text))),
  status: z.enum(["ready", "running", "review", "accepted", "blocked", "stopped"]),
});
export type ProjectMilestone = z.infer<typeof milestoneRowSchema>;

export function parseProjectAction(text: string) {
  const directives = parseWorkflow(text).map((input) => projectActionSchema.parse(input));
  if (directives.some((item) => item.action === "project_reply" && item.question && item.review)) {
    throw new Error("Ask a user question or review the work, not both");
  }
  const actions = directives.filter(
    (item) => item.action !== "project_reply" || item.review || item.question,
  );
  const unique = new Map(actions.map((item) => [JSON.stringify(item), item]));
  if (unique.size > 1) {
    throw new Error(
      "Conflicting workflow actions; return one action, combining review with run or task when needed",
    );
  }
  return unique.values().next().value ?? directives[0];
}

export function serializeCheck(check: CheckDefinition) {
  return {
    name: check.name,
    command: check.command,
    cwd: check.cwd === "." ? undefined : check.cwd,
    network: check.network || undefined,
    writable: check.writable || undefined,
  };
}
