import { defineConfig } from "vitest/config";

// Root config for tests outside packages/. Worktrees under .claude/ and vendored code are not ours to run.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "vendor/**", "spikes/**"],
  },
});
