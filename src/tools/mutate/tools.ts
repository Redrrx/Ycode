import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { INPUT_LIMITS, MUTATION_LIMITS, TOOL_NAMES } from "../../config/constants.ts";
import type { WriteJournal } from "../../project/writes.ts";
import { toolDescriptions } from "../../prompts.ts";
import type { TaskSpec } from "../../workflow/protocol.ts";
import type { FileEditor } from "./editor.ts";
import { createFileEditor } from "./editor.ts";
import { createVerifiedFile, verifiedEdit } from "./files.ts";
function createEditTool(editor: FileEditor, operationId: (id: string) => string | undefined) {
  const editSchema = Type.Object(
    {
      path: Type.String({ minLength: 1, maxLength: INPUT_LIMITS.pathChars }),
      description: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 240,
          description: "One line: what changes and why; saved in change history",
        }),
      ),
      edits: Type.Array(
        Type.Object(
          {
            oldText: Type.String({ minLength: 1, maxLength: MUTATION_LIMITS.replacementChars }),
            newText: Type.String({ maxLength: MUTATION_LIMITS.replacementChars }),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: MUTATION_LIMITS.replacements },
      ),
    },
    { additionalProperties: false },
  );

  return defineTool({
    name: TOOL_NAMES.edit,
    label: "Apply Edit",
    description: toolDescriptions.edit,
    parameters: editSchema,
    executionMode: "sequential",
    async execute(id, parameters, signal, _update, context) {
      return editor.execute(
        context,
        {
          operation: "edit",
          path: parameters.path,
          proposal: parameters.edits,
          description: parameters.description,
          operationId: operationId(id),
        },
        signal,
        async (prepared) => {
          const tool = verifiedEdit(context.cwd, prepared);
          const result = await tool.execute(
            id,
            { edits: parameters.edits, path: prepared.path },
            prepared.signal,
            undefined,
            context,
          );
          const text = result.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          if (result.isError) {
            throw new Error(text);
          }
          return text;
        },
      );
    },
  });
}

function createFileTool(editor: FileEditor, operationId: (id: string) => string | undefined) {
  return defineTool({
    name: TOOL_NAMES.create,
    label: "Create File",
    description: toolDescriptions.create,
    parameters: Type.Object(
      {
        path: Type.String({ minLength: 1, maxLength: INPUT_LIMITS.pathChars }),
        description: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 240,
            description: "One line: what this file adds and why; saved in change history",
          }),
        ),
        content: Type.String({ maxLength: MUTATION_LIMITS.newFileChars }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(id, parameters, signal, _update, context) {
      return editor.execute(
        context,
        {
          operation: "create",
          path: parameters.path,
          proposal: parameters.content,
          description: parameters.description,
          operationId: operationId(id),
        },
        signal,
        async (prepared) => {
          await createVerifiedFile(prepared, parameters.content);
          return `Created ${parameters.path}; saved text was verified. No build or tests were run.`;
        },
      );
    },
  });
}

export function createMutationTools(
  taskSpec: TaskSpec,
  sourceHashes: Map<string, string>,
  changed: (path: string) => void,
  journal?: WriteJournal,
  operationId: (id: string) => string | undefined = () => undefined,
) {
  const editor = createFileEditor(taskSpec, sourceHashes, changed, journal);
  return [createEditTool(editor, operationId), createFileTool(editor, operationId)];
}
