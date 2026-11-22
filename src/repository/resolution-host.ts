import { isUtf8 } from "node:buffer";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import ts from "typescript";
import { REPOSITORY_LIMITS } from "../config/constants.ts";
import { inside } from "./tree.ts";
function metadataBytes(fd: number): Buffer | undefined {
  const info = fstatSync(fd);
  if (!info.isFile() || info.size > REPOSITORY_LIMITS.sourceFileBytes) {
    return undefined;
  }
  const data = Buffer.alloc(info.size + 1);
  const count = readSync(fd, data, 0, data.length, 0);
  return count === info.size ? data.subarray(0, count) : undefined;
}

function readMetadata(path: string, root: string): string | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = realpathSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : path);
    if (!inside(root, opened)) {
      return undefined;
    }
    const data = metadataBytes(fd);
    return data && isUtf8(data) && !data.includes(0) ? data.toString("utf8") : undefined;
  } finally {
    closeSync(fd);
  }
}

export function resolutionHost(root: string, signal: AbortSignal): ts.ParseConfigHost {
  const canonical = (path: string): string | undefined => {
    signal.throwIfAborted();
    try {
      const value = realpathSync(path);
      return inside(root, value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const stat = (path: string) => {
    const value = canonical(path);
    return value ? statSync(value, { throwIfNoEntry: false }) : undefined;
  };
  return {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (path) => stat(path)?.isFile() ?? false,
    directoryExists: (path) => stat(path)?.isDirectory() ?? false,
    readDirectory: () => [],
    realpath: (path) => canonical(path) ?? path,
    readFile(path) {
      const value = canonical(path);
      if (!value) {
        return undefined;
      }
      try {
        return readMetadata(value, root);
      } catch {
        return undefined;
      }
    },
  };
}
