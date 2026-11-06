import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Root config for tests outside packages/. Worktrees under .claude/ and vendored code are not ours to run.
export default defineConfig({
  test: {
    // Core's tests make a folder each, so a run through this config needs the same cleanup as one from packages/core.
    globalSetup: [fileURLToPath(new URL("./packages/core/test/global-setup.ts", import.meta.url))],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "vendor/**", "spikes/**"],
  },
});
