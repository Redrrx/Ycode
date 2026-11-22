import { extname } from "node:path";
export function referenceLanguage(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "TypeScript";
    case ".tsx":
      return "Tsx";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "JavaScript";
    default:
      return undefined;
  }
}

function sourceField(kind: string) {
  return { all: [{ kind }, { has: { field: "source", kind: "string", pattern: "$SOURCE" } }] };
}

export function referenceArguments(language: string): string[] {
  const calls = {
    any: [{ pattern: "import($SOURCE)" }, { pattern: "import($SOURCE, $$$OPTIONS)" }],
  };
  const typeContext = {
    inside: {
      any: [
        "type_alias_declaration",
        "type_annotation",
        "type_arguments",
        "interface_declaration",
      ].map((kind) => ({ kind })),
      stopBy: "end",
    },
  };
  const typed = language !== "JavaScript";
  const rules = [
    { id: "import", rule: sourceField("import_statement") },
    { id: "export", rule: sourceField("export_statement") },
    {
      id: "require",
      rule: {
        any: [
          { pattern: "require($SOURCE)" },
          ...(language === "JavaScript" ? [] : [sourceField("import_require_clause")]),
        ],
      },
    },
    { id: "dynamic", rule: typed ? { all: [calls, { not: typeContext }] } : calls },
    ...(typed ? [{ id: "type", rule: { all: [calls, typeContext] } }] : []),
    { id: "parse-error", rule: { kind: "ERROR" } },
  ].map((rule) =>
    JSON.stringify({ ...rule, language, message: "Module reference", severity: "hint" }),
  );
  return [
    "scan",
    "--inline-rules",
    rules.join("\n---\n"),
    "--stdin",
    "--json=compact",
    "--custom-languages",
    "ignore",
  ];
}
