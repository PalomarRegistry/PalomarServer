import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", ".wrangler/**", "public/preflight.js"] },
  {
    files: ["**/*.js"],
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: js.configs.recommended.rules,
  },
  {
    files: ["src/**/*.js", "redirect/**/*.js"],
    languageOptions: { globals: globals.worker },
  },
  {
    files: ["public/**/*.js", "browser/**/*.js"],
    ignores: ["public/normalize.js", "public/statuses.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["tests/**/*.js", "runtime-tests/config.js", "*.config.js"],
    languageOptions: { globals: globals.nodeBuiltin },
  },
  {
    files: ["runtime-tests/**/*.test.js"],
    languageOptions: { globals: globals.worker },
  },
];
