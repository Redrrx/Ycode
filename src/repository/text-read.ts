import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { inside } from "./tree.ts";
export function textFileError(message: string): Error {
  const error = new Error(message);
  error.name = "TextFileError";
  return error;
}

export function isTextFileError(error: unknown): error is Error {
  return error instanceof Error && error.name === "TextFileError";
}

async function containedHandle(handle: FileHandle, root: string, path: string): Promise<void> {
  const canonical = await realpath(
    process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path,
  );
  if (!inside(root, canonical)) {
    throw new Error("Path escaped scope");
  }
  if (process.platform !== "linux") {
    const opened = await handle.stat();
    const current = await stat(canonical);
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("File changed while opening; no source returned");
    }
  }
}

async function readLimited(
  handle: FileHandle,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < buffer.length) {
    signal.throwIfAborted();
    const read = await handle.read(buffer, length, buffer.length - length, length);
    if (!read.bytesRead) {
      break;
    }
    length += read.bytesRead;
  }
  signal.throwIfAborted();
  return buffer.subarray(0, length);
}

export async function readTextSource(
  root: string,
  path: string,
  signal: AbortSignal,
  limit: number,
): Promise<Buffer> {
  signal.throwIfAborted();
  const absolute = await realpath(resolve(root, path));
  if (!inside(root, absolute)) {
    throw new Error("Path escaped scope");
  }
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error("Expected a regular source file");
    }
    if (info.size > limit) {
      throw textFileError(`Text file exceeds ${limit} bytes: ${path}`);
    }
    await containedHandle(handle, root, absolute);
    const data = await readLimited(handle, limit, signal);
    await containedHandle(handle, root, absolute);
    if (data.length > limit || data.includes(0) || !isUtf8(data)) {
      throw textFileError(`Binary, invalid UTF-8 or oversized text file: ${path}`);
    }
    return data;
  } finally {
    await handle.close();
  }
}
