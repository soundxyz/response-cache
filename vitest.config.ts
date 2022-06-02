import { defineConfig } from "vite";
import type {} from "vitest";

export default defineConfig({
  test: {
    testTimeout: 2000,
    globals: true,
  },
});
