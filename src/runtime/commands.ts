import {
  createLocalBashOperations,
  createLocalPowerShellOperations,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import type { CommandOutcome, ExecutionStore } from "../project/execution.ts";
import { inside } from "../repository/tree.ts";
import { createCommandOutput } from "./command-output.ts";

export const commandShell = process.platform === "win32" ? "PowerShell" : "Bash";

export interface CommandRequest {
  command: string;
  cwd?: string;
  network?: boolean;
}

interface Running {
  stop: AbortController;
  done: Promise<void>;
  writable: boolean;
  network: boolean;
}

interface CommandRunnerData {
  readonly active: Map<string, Running>;
  readonly operations: BashOperations;
  readonly store: ExecutionStore;
  readonly taskSignal: AbortSignal;
  readonly writableEnded: () => void;
  closed: boolean;
  failure: Error | undefined;
}

export type CommandRunner = Pick<
  ReturnType<typeof bindCommandRunner>,
  "hasWritableProcesses" | "start" | "canProbe" | "stop" | "dispose"
>;

export function createCommandRunner(
  store: ExecutionStore,
  signal: AbortSignal,
  writableEnded: () => void,
): CommandRunner {
  return bindCommandRunner({
    active: new Map<string, Running>(),
    operations:
      process.platform === "win32"
        ? createLocalPowerShellOperations()
        : createLocalBashOperations(),
    store,
    taskSignal: signal,
    writableEnded,
    closed: false,
    failure: undefined,
  });
}

function bindCommandRunner(self: CommandRunnerData) {
  return Object.assign(self, {
    hasWritableProcesses: () => [...self.active.values()].some((run) => run.writable),
    start: commandRunnerStart.bind(undefined, self),
    canProbe: (id: string) => self.active.get(id)?.network ?? false,
    stop: commandRunnerStop.bind(undefined, self),
    dispose: commandRunnerDispose.bind(undefined, self),
  });
}

async function commandRunnerStart(
  self: CommandRunnerData,
  rootPath: string,
  request: CommandRequest,
  writable: boolean,
  options: { background?: boolean; timeoutSeconds?: number; signal?: AbortSignal },
) {
  const root = await realpath(rootPath);
  const cwd = await realpath(resolve(root, request.cwd ?? "."));
  if (!inside(root, cwd)) {
    throw new Error("Command working directory escaped the project");
  }
  if (self.failure) {
    throw self.failure;
  }
  if (self.closed) {
    throw new Error("Task command execution has ended");
  }
  const stop = new AbortController();
  const signal = AbortSignal.any([
    self.taskSignal,
    stop.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const timeout = options.timeoutSeconds ?? (options.background ? undefined : 120);
  const id = self.store.begin({ ...request, writable, shell: commandShell }, cwd);
  const done = Promise.resolve().then(() =>
    commandRunnerExecute(self, id, request.command, cwd, stop, signal, timeout, writable),
  );
  self.active.set(id, { stop, done, writable, network: Boolean(request.network) });
  void done.catch((error: unknown) => {
    self.failure = error instanceof Error ? error : new Error(String(error));
  });
  if (!options.background) {
    await done;
  }
  return {
    ...self.store.result(id),
    output: self.store.logs(id),
    longLived: Boolean(options.background),
    note: "Host shell execution, without isolation. Network and writable flags declare intent, not OS restrictions. Output combines stdout and stderr. Background means requested, not ready. Detached daemons may outlive the task.",
  };
}

async function commandRunnerExecute(
  self: CommandRunnerData,
  id: string,
  command: string,
  cwd: string,
  stop: AbortController,
  signal: AbortSignal,
  timeout: number | undefined,
  writable: boolean,
): Promise<void> {
  const output = createCommandOutput((text) => self.store.append(id, "combined", text));
  let failure: unknown;
  let exitCode: number | null = null;
  let timedOut = false;
  try {
    const result = await self.operations.exec(command, cwd, {
      signal,
      timeout,
      onData(data) {
        try {
          output.push(data);
        } catch (error) {
          failure = error;
          stop.abort(error);
        }
      },
    });
    exitCode = result.exitCode;
  } catch (error) {
    timedOut = error instanceof Error && error.message.startsWith("timeout:");
    if (!signal.aborted && !timedOut) {
      failure = error;
    }
  }
  try {
    output.finish();
    if (failure) {
      self.store.append(
        id,
        "error",
        failure instanceof Error ? failure.message : "Command execution or output capture failed",
      );
    }
  } catch (error) {
    failure = error;
  }
  try {
    if (writable) {
      self.writableEnded();
    }
    self.store.finish(id, commandOutcome(exitCode, signal.aborted, timedOut, Boolean(failure)));
  } finally {
    self.active.delete(id);
  }
}

function commandOutcome(
  exitCode: number | null,
  cancelled: boolean,
  timedOut: boolean,
  failed: boolean,
): CommandOutcome {
  let status: CommandOutcome["status"] = "failed";
  if (!failed) {
    if (timedOut) {
      status = "timeout";
    } else if (cancelled) {
      status = "cancelled";
    } else if (exitCode === 0) {
      status = "passed";
    }
  }
  return { status, exitCode, signal: null, endedAt: Date.now() };
}

async function commandRunnerStop(self: CommandRunnerData, id: string): Promise<void> {
  const run = self.active.get(id);
  if (!run) {
    self.store.result(id);
    return;
  }
  run.stop.abort(new Error("Process stopped"));
  await run.done;
}

async function commandRunnerDispose(self: CommandRunnerData): Promise<void> {
  self.closed = true;
  const runs = [...self.active.values()];
  for (const run of runs) {
    run.stop.abort(new Error("Task ended"));
  }
  await Promise.all(runs.map((run) => run.done));
  if (self.failure) {
    throw self.failure;
  }
}

export async function probePort(
  port: number,
  signal?: AbortSignal,
): Promise<{ port: number; reachable: boolean; note: string }> {
  signal?.throwIfAborted();
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean) => {
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve(value);
    };
    const abort = () => finish(false);
    socket.setTimeout(3000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    signal?.addEventListener("abort", abort, { once: true });
  });
  signal?.throwIfAborted();
  return {
    port,
    reachable,
    note: "TCP connectivity only; this does not identify the responding process or verify application behavior.",
  };
}
