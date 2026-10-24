import js from "@eslint/js";
import globals from "globals";
export default [
  {
    ignores: [
      "node_modules/**",
      "desktop-resources/**",
      "src-tauri/**",
      "backups-codigo/**",
      "design/**",
      ".preview-data/**",
      ".stryker-tmp/**",
      "reports/**",
      "coverage/**",
      "data/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      eqeqeq: "error",
      "no-var": "error",
      "prefer-const": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-warning-comments": [
        "error",
        { terms: ["eslint-disable", "Stryker disable"], location: "anywhere" },
      ],
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: { globals: { ...globals.browser, Chart: "readonly" } },
  },
];
