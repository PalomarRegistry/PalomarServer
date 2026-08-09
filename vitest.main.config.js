import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";
import { rejectOutbound } from "./runtime-tests/config.js";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        outboundService: rejectOutbound,
        // Test-only values for the configuration guard. Outbound traffic is
        // intercepted inside workerd and these confer no external authority.
        bindings: {
          TOKEN_PEPPER: "runtime-test-pepper",
          GITHUB_TOKEN: "runtime-test-state-token",
          SUBMISSION_TOKEN: "runtime-test-dispatch-token",
          OAUTH_CLIENT_ID: "runtime-test-client-id",
          OAUTH_CLIENT_SECRET: "runtime-test-client-secret",
        },
      },
    }),
  ],
  test: {
    name: "submission-worker",
    include: ["runtime-tests/main-worker.test.js"],
  },
});
