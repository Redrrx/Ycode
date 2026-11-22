import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MUTATION_LIMITS } from "../../config/constants.ts";
import type { WriteJournal } from "../../project/writes.ts";
import type { TaskSpec } from "../../workflow/protocol.ts";
import { sourceHash } from "../explore/inspect.ts";
import { prepareMutation, type Mutation, type PreparedMutation } from "./files.ts";
function failure(error: unknown) {
  return {
    content: [
      { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
    ],
    details: undefined,
    isError: true,
  };
}

interface FileEditorData {
  readonly taskSpec: TaskSpec;
  readonly sourceHashes: Map<string, string>;
  readonly changed: (path: string) => void;
  readonly journal: WriteJournal | undefined;
}

export type FileEditor = Pick<ReturnType<typeof bindFileEditor>, "execute">;

export function createFileEditor(
  taskSpec: TaskSpec,
  sourceHashes: Map<string, string>,
  changed: (path: string) => void,
  journal?: WriteJournal,
): FileEditor {
  return bindFileEditor({
    taskSpec,
    sourceHashes,
    changed,
    journal,
  });
}

function bindFileEditor(self: FileEditorData) {
  return Object.assign(self, {
    execute: fileEditorExecute.bind(undefined, self),
  });
}

async function fileEditorExecute(
  self: FileEditorData,
  context: ExtensionContext,
  mutation: Mutation,
  signal: AbortSignal | undefined,
  apply: (prepared: PreparedMutation) => Promise<string>,
) {
  const deadline = AbortSignal.timeout(MUTATION_LIMITS.deadlineMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    if (self.taskSpec.mode !== "edit") {
      throw new Error("This task does not authorize mutations");
    }
    combined.throwIfAborted();
    const prepared = await prepareMutation(context.cwd, mutation, combined);
    prepared.journal = self.journal;
    if (
      mutation.operation === "edit" &&
      self.sourceHashes.get(prepared.path) !== sourceHash(Buffer.from(prepared.before))
    ) {
      throw new Error(
        "File has not been inspected or changed since inspection. Use code_inspect before editing; no file changed.",
      );
    }
    const proposal = JSON.stringify(mutation.proposal);
    if (Buffer.byteLength(prepared.before + proposal) > MUTATION_LIMITS.inputBytes) {
      throw new Error(
        `Mutation input exceeds ${MUTATION_LIMITS.inputBytes / 1024} KiB; use a smaller change.`,
      );
    }
    combined.throwIfAborted();
    let text: string;
    try {
      text = await apply(prepared);
    } finally {
      self.changed(prepared.path);
    }
    return { content: [{ type: "text" as const, text }], details: undefined };
  } catch (error) {
    return failure(error);
  }
}
