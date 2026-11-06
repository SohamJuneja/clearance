import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Runs the tests of `eval/` and `scripts/`, which live outside the pnpm workspace packages. */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["eval/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/.tmp/**"],
    testTimeout: 15_000,
  },
});
