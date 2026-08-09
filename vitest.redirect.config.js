import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";
import { rejectOutbound } from "./runtime-tests/config.js";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./redirect/wrangler.jsonc" },
      miniflare: { outboundService: rejectOutbound },
    }),
  ],
  test: {
    name: "redirect-worker",
    include: ["runtime-tests/redirect-worker.test.js"],
  },
});
