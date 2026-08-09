import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "./vitest.main.config.js",
      "./vitest.redirect.config.js",
    ],
  },
});
