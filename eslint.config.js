import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", ".wrangler/**"] },
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
    files: ["public/**/*.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["tests/**/*.js", "*.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["runtime-tests/**/*.js"],
    languageOptions: { globals: globals.worker },
  },
];
