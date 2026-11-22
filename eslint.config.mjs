import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**"],
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.mjs"],
    extends: [eslint.configs.recommended, prettier],
    languageOptions: {
      globals: { process: "readonly", console: "readonly", structuredClone: "readonly" },
    },
    rules: {
      curly: ["error", "all"],
      eqeqeq: ["error", "always"],
      "no-empty": "error",
      "no-nested-ternary": "error",
      "no-multi-assign": "error",
      "no-sequences": "error",
    },
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked, prettier],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "error" },
    rules: {
      curly: ["error", "all"],
      eqeqeq: ["error", "always"],
      "no-nested-ternary": "error",
      "no-multi-assign": "error",
      "no-sequences": "error",
      "no-else-return": "error",
      "no-console": "error",
      "no-empty": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-expect-error": true,
          "ts-check": false,
        },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      complexity: ["error", 12],
      "max-depth": ["error", 3],
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression:not([typeAnnotation.typeName.name='const'])",
          message:
            "Do not cast data into a type. Parse external data with a schema or narrow a discriminated union.",
        },
        {
          selector: "UnaryExpression[operator='typeof']",
          message: "Do not hand-roll boundary shape checks. Define and parse a schema.",
        },
      ],
    },
  },
);
