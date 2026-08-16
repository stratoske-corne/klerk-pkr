import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000, // spawns a real child process per test — a bit more headroom than the default 5s
  },
});
