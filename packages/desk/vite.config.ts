import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The server's CSP refuses inline scripts, and the polyfill is the only one Vite would add.
    modulePreload: { polyfill: false },
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
