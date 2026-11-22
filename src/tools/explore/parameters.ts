import { Type } from "typebox";
import {
  INPUT_LIMITS,
  EXPLORATION_LIMITS as LIMITS,
  WORKER_LIMITS,
} from "../../config/constants.ts";
export function readParameters() {
  return {
    target: Type.String({
      minLength: 1,
      maxLength: INPUT_LIMITS.targetChars,
      description: "Question to answer",
    }),
    followReferences: Type.Optional(
      Type.Boolean({
        description: "Read related files in this call; default false",
      }),
    ),
    notes: Type.Optional(
      Type.String({
        maxLength: WORKER_LIMITS.notesChars,
        description: "Optional working notes; empty clears",
      }),
    ),
    workspace: Type.Optional(
      Type.String({
        maxLength: INPUT_LIMITS.taskIdChars,
        description: "Earlier workspace ID; omit for cwd",
      }),
    ),
    scope: Type.Optional(
      Type.String({ maxLength: INPUT_LIMITS.pathChars, description: "Directory relative to cwd" }),
    ),
    summary: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: LIMITS.workspaceSummaryChars,
        description: "Summary of files read",
      }),
    ),
    sourcePaths: Type.Optional(
      Type.Array(Type.String({ maxLength: INPUT_LIMITS.pathChars }), {
        maxItems: LIMITS.workspaceSourcePaths,
        description: "Files read for this summary",
      }),
    ),
  };
}
export function overviewParameters() {
  return Type.Object(
    {
      ...readParameters(),
      depth: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Directory depth below scope; default 1",
        }),
      ),
      cursor: Type.Optional(Type.String({ maxLength: 500, description: "Next page of names" })),
    },
    { additionalProperties: false },
  );
}
export function findParameters() {
  return Type.Object(
    {
      ...readParameters(),
      literal: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 1000,
          description: "Exact case-sensitive text",
        }),
      ),
      search: Type.Optional(
        Type.String({
          maxLength: INPUT_LIMITS.taskIdChars,
          description: "Continue search ID; keep target/literal",
        }),
      ),
    },
    { additionalProperties: false },
  );
}
export function inspectionParameters() {
  return Type.Object(
    {
      ...readParameters(),
      path: Type.String({ minLength: 1, maxLength: INPUT_LIMITS.pathChars }),
      referenceOffset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Continue referenceAnalysis.nextOffset",
        }),
      ),
      declarations: Type.Optional(Type.Boolean({ description: "Include AST declarations" })),
      startLine: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "First line of path",
        }),
      ),
      endLine: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "Last line of path",
        }),
      ),
      relatedPaths: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: INPUT_LIMITS.pathChars }), {
          maxItems: LIMITS.findingsPerCall - 1,
          uniqueItems: true,
          description: "Related files; start at line 1",
        }),
      ),
    },
    { additionalProperties: false },
  );
}
