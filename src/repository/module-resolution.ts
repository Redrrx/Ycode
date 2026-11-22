import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import type { ModuleReference } from "./references.ts";
import { resolutionHost } from "./resolution-host.ts";
import { inside, relativePath } from "./tree.ts";
function nearestConfig(file: string, root: string, host: ts.ParseConfigHost): string | undefined {
  let directory = dirname(file);
  while (inside(root, directory)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const path = resolve(directory, name);
      if (host.fileExists(path)) {
        return path;
      }
    }
    if (directory === root) {
      break;
    }
    directory = dirname(directory);
  }
  return undefined;
}

function compilerOptions(file: string, root: string, host: ts.ParseConfigHost) {
  const config = nearestConfig(file, root, host);
  if (!config) {
    return {
      options: {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        allowJs: true,
        resolveJsonModule: true,
      },
      warnings: [],
    };
  }
  const input = ts.readConfigFile(config, (path) => host.readFile(path));
  if (input.error) {
    throw new Error(ts.flattenDiagnosticMessageText(input.error.messageText, " "));
  }
  const parsed = ts.parseJsonConfigFileContent(
    input.config,
    host,
    dirname(config),
    undefined,
    config,
  );
  const errors = parsed.errors.filter((error) => error.code !== 18003 && error.code !== 18002);
  return {
    options: parsed.options,
    warnings: errors
      .slice(0, 3)
      .map(
        (error) =>
          `Module config: ${ts.flattenDiagnosticMessageText(error.messageText, " ").slice(0, 240)}`,
      ),
  };
}

interface ModuleResolverData {
  readonly root: string;
  readonly file: string;
  readonly host: ts.ParseConfigHost;
  readonly options: ts.CompilerOptions;
  readonly warnings: string[];
}

export type ModuleResolver = Pick<ReturnType<typeof bindModuleResolver>, "warnings" | "resolve">;

export function createModuleResolver(
  root: string,
  file: string,
  signal: AbortSignal,
): ModuleResolver {
  const host: ts.ParseConfigHost = resolutionHost(root, signal);
  const config = compilerOptions(file, root, host);
  const initialOptions: ts.CompilerOptions = config.options;
  const initialWarnings: string[] = config.warnings;

  return bindModuleResolver({
    root,
    file,
    host,
    options: initialOptions,
    warnings: initialWarnings,
  });
}

function bindModuleResolver(self: ModuleResolverData) {
  return Object.assign(self, {
    resolve: moduleResolverResolve.bind(undefined, self),
  });
}

function moduleResolverResolve(
  self: ModuleResolverData,
  reference: ModuleReference,
): { path?: string; unresolved?: string; external?: string } {
  const specifier = reference.specifier;
  if (specifier === undefined) {
    return {
      unresolved: `Computed ${reference.kind} at line ${reference.line}; target is unknown`,
    };
  }
  if (isBuiltin(specifier)) {
    return { external: specifier };
  }
  const target = moduleResolverTarget(self, specifier, reference.kind);
  if (!target || !self.host.fileExists(target)) {
    return {
      unresolved: `${specifier.slice(0, 160)} (not resolved inside the workspace; absence not established)`,
    };
  }
  const canonical = self.host.realpath?.(target) ?? target;
  if (!inside(self.root, canonical)) {
    return { unresolved: `${specifier.slice(0, 160)} (target is outside the workspace)` };
  }
  return { path: relativePath(self.root, canonical) };
}

function moduleResolverTarget(
  self: ModuleResolverData,
  specifier: string,
  kind: ModuleReference["kind"],
): string | undefined {
  const result = ts.resolveModuleName(
    specifier,
    self.file,
    self.options,
    self.host,
    undefined,
    undefined,
    moduleResolverMode(self, kind),
  );
  if (result.resolvedModule) {
    return result.resolvedModule.resolvedFileName;
  }
  const exact = specifier.startsWith(".") ? resolve(dirname(self.file), specifier) : undefined;
  return exact && self.host.fileExists(exact) ? exact : undefined;
}

function moduleResolverMode(
  self: ModuleResolverData,
  kind: ModuleReference["kind"],
): ts.ResolutionMode {
  if (kind === "require") {
    return ts.ModuleKind.CommonJS;
  }
  if (kind === "dynamic") {
    return ts.ModuleKind.ESNext;
  }
  const nodeMode =
    self.options.moduleResolution === undefined
      ? [
          ts.ModuleKind.Node16,
          ts.ModuleKind.Node18,
          ts.ModuleKind.Node20,
          ts.ModuleKind.NodeNext,
        ].includes(self.options.module ?? ts.ModuleKind.None)
      : [ts.ModuleResolutionKind.Node16, ts.ModuleResolutionKind.NodeNext].includes(
          self.options.moduleResolution,
        );
  if (nodeMode) {
    return ts.getImpliedNodeFormatForFile(self.file, undefined, self.host, self.options);
  }
  return undefined;
}
