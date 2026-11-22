import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { redact, safeText } from "../../activity/data.ts";
import type { TaskActivity } from "../../activity/task.ts";
import { TOOL_NAMES } from "../../config/constants.ts";
import type { RoleConfig } from "../../config/load.ts";
import { createTaskDecisionClient } from "../../decision/runtime.ts";
import type { ExecutionStore, RecordedCheck } from "../../project/execution.ts";
import type { CommandRunner } from "../../runtime/commands.ts";
import { commandShell, createCommandRunner, probePort } from "../../runtime/commands.ts";
import type { TaskSpec } from "../../workflow/protocol.ts";
import type { SearchState } from "../explore/state.ts";
import type { Request } from "./diagnostics.ts";
import { fitCommandResult, inspectDiagnostics, writableRequest } from "./diagnostics.ts";
interface ExecutionToolsData {
  readonly runner: CommandRunner;
  readonly config: RoleConfig;
  readonly taskSpec: TaskSpec;
  readonly activity: TaskActivity;
  readonly state: SearchState;
  readonly store: ExecutionStore;
  networkApproved: boolean;
  readonly checks: Map<string, { id: string; generation: number }>;
}

export type ExecutionTools = Pick<
  ReturnType<typeof bindExecutionTools>,
  "runner" | "completedChecks" | "completedCheckRuns" | "execute" | "process"
>;

export function createExecutionTools(
  config: RoleConfig,
  taskSpec: TaskSpec,
  activity: TaskActivity,
  state: SearchState,
  store: ExecutionStore,
  signal: AbortSignal,
): ExecutionTools {
  const runner: CommandRunner = createCommandRunner(store, signal, () => state.invalidate(true));

  return bindExecutionTools({
    runner,
    config,
    taskSpec,
    activity,
    state,
    store,
    networkApproved: false,
    checks: new Map<string, { id: string; generation: number }>(),
  });
}

function bindExecutionTools(self: ExecutionToolsData) {
  return Object.assign(self, {
    completedChecks: executionToolsCompletedChecks.bind(undefined, self),
    completedCheckRuns: executionToolsCompletedCheckRuns.bind(undefined, self),
    execute: executionToolsExecute.bind(undefined, self),
    process: executionToolsProcess.bind(undefined, self),
  });
}

function executionToolsCompletedChecks(self: ExecutionToolsData): string[] {
  return executionToolsCompletedCheckRuns(self).map((item) => item.check);
}

function executionToolsCompletedCheckRuns(self: ExecutionToolsData): RecordedCheck[] {
  if (self.runner.hasWritableProcesses()) {
    return [];
  }
  return [...self.checks]
    .filter(([, value]) => value.generation === self.state.generation)
    .map(([check, value]) => ({ check, run: value.id, generation: value.generation }));
}

async function executionToolsAuthorize(
  self: ExecutionToolsData,
  context: ExtensionContext,
  request: Request,
  signal?: AbortSignal,
): Promise<void> {
  if (!self.taskSpec.execution?.commands) {
    throw new Error(
      "Command execution is not authorized for this task; ask Main for execution permission",
    );
  }
  if (!request.network || self.taskSpec.execution.network || self.networkApproved) {
    return;
  }
  if (
    !context.hasUI ||
    !(await context.ui.confirm(
      "Allow task network access?",
      safeText(
        redact(
          `${request.command}\nApprove intended network use for this task. Commands run with your normal permissions and environment; network and filesystem access are not isolated.`,
        ),
      ),
      { signal },
    ))
  ) {
    throw new Error("Network access was not approved; command was not executed");
  }
  signal?.throwIfAborted();
  self.networkApproved = true;
}

async function executionToolsExecute(
  self: ExecutionToolsData,
  id: string,
  request: Request,
  context: ExtensionContext,
  signal?: AbortSignal,
) {
  if (Buffer.byteLength(JSON.stringify(request)) > 48000) {
    throw new Error("Command request exceeds 48 KiB");
  }
  await executionToolsAuthorize(self, context, request, signal);
  const writable = writableRequest(self.taskSpec, request);
  const stableAtStart = !self.runner.hasWritableProcesses();
  if (request.check) {
    self.checks.delete(request.check);
  }
  if (writable) {
    self.state.invalidate(true);
  }
  const result = await self.runner
    .start(context.cwd, request, writable, {
      ...request,
      signal,
    })
    .finally(() => {
      if (writable) {
        self.state.invalidate(true);
      }
    });
  executionToolsRecordCheck(self, request.check, result, stableAtStart);
  return executionToolsCommandResult(self, id, request, result, context, signal);
}

function executionToolsRecordCheck(
  self: ExecutionToolsData,
  name: string | undefined,
  result: { id: string; status: string },
  stableAtStart: boolean,
): void {
  if (name && stableAtStart && result.status === "passed" && !self.runner.hasWritableProcesses()) {
    self.checks.set(name, { id: result.id, generation: self.state.generation });
  }
}

async function executionToolsCommandResult(
  self: ExecutionToolsData,
  id: string,
  request: Request,
  result: Awaited<ReturnType<CommandRunner["start"]>>,
  context: ExtensionContext,
  signal?: AbortSignal,
) {
  const decisions = createTaskDecisionClient(
    context,
    self.config,
    self.taskSpec,
    self.activity,
    id,
    signal ?? context.signal ?? new AbortController().signal,
    self.state.decisionUnavailable,
  );
  let diagnostic: Awaited<ReturnType<typeof inspectDiagnostics>> | undefined;
  const tail = self.store.tail(result.id);
  if (result.status === "failed" && request.diagnose === true) {
    diagnostic = await inspectDiagnostics(
      context,
      self.state,
      self.activity,
      id,
      tail,
      result.cwd,
      self.taskSpec.objective,
      decisions,
    );
  }
  self.state.decisionUnavailable ||= decisions.unavailable;
  const data = {
    ...result,
    command: result.command.slice(0, 240),
    ...diagnostic,
    tail: tail.slice(-4000),
    warnings: [...(diagnostic?.warnings ?? []), ...decisions.warnings],
    completedChecks: executionToolsCompletedChecks(self),
    completedCheckRuns: executionToolsCompletedCheckRuns(self),
  };
  fitCommandResult(data);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    details: data,
    isError: !request.background && result.status !== "passed",
    usage: decisions.usage,
  };
}

async function executionToolsProcess(
  self: ExecutionToolsData,
  action: "status" | "logs" | "stop" | "probe",
  id: string,
  cursor?: number,
  port?: number,
  signal?: AbortSignal,
) {
  if (action === "stop") {
    await self.runner.stop(id);
  }
  const run = self.store.result(id);
  run.command = run.command.slice(0, 240);
  if (action === "probe") {
    if (!port || !self.runner.canProbe(id)) {
      throw new Error(
        "Probe requires a port and a running task-owned process with approved host-network access",
      );
    }
    return { run, probe: await probePort(port, signal) };
  }
  if (action === "logs") {
    return { run, output: self.store.logs(id, cursor) };
  }
  return { run };
}

export function executionTools(service: ExecutionTools) {
  const command = defineTool({
    name: TOOL_NAMES.command,
    label: "Run Command",
    executionMode: "sequential",
    description: `Run a ${commandShell} command through Pi with normal user permissions and environment. No isolation. Command permission is required. Declare intended writes with writable=true and network use with network=true; permission checks do not restrict the OS. Quote for ${commandShell}. Return the real failure exit code, including for multi-step commands and pipelines. Use background=true for a live server, never shell detachment or daemonization. Read status and combined output with process_control. Background means requested, not ready. Set diagnose=true for source diagnostics. The decision model's choices are best-effort; misleading code can make them wrong.`,
    parameters: Type.Object(
      {
        command: Type.String({ minLength: 1, maxLength: 12000 }),
        cwd: Type.Optional(Type.String({ maxLength: 1000 })),
        network: Type.Optional(
          Type.Boolean({ description: "Declare intended network use; not an OS restriction" }),
        ),
        background: Type.Optional(Type.Boolean()),
        writable: Type.Optional(
          Type.Boolean({
            description: "Declare intended writes; requires edit permission, not an OS restriction",
          }),
        ),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 2147483 })),
        check: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 120,
            description: "Requested check name; result comes from the command exit status",
          }),
        ),
        diagnose: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    async execute(id, parameters, signal, _update, context) {
      return service.execute(id, parameters, context, signal);
    },
  });
  const process = defineTool({
    name: TOOL_NAMES.process,
    label: "Process Control",
    executionMode: "sequential",
    description:
      "Read status or combined log pages, cancel a task-owned Pi execution, or test a loopback TCP port. A probe requires an active call with approved network intent and an explicit port. A running call or open port does not prove the application works. Active calls are cancelled at task end. Detached daemons may outlive the task. No arbitrary PID access or command replay.",
    parameters: Type.Object(
      {
        action: Type.Union([
          Type.Literal("status"),
          Type.Literal("logs"),
          Type.Literal("stop"),
          Type.Literal("probe"),
        ]),
        runId: Type.String({ minLength: 1, maxLength: 120 }),
        cursor: Type.Optional(Type.Integer({ minimum: 0 })),
        port: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 65535,
            description: "Loopback TCP port for probe; this does not verify the application",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, parameters, signal) {
      const result = await service.process(
        parameters.action,
        parameters.runId,
        parameters.cursor,
        parameters.port,
        signal,
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  return [command, process];
}
