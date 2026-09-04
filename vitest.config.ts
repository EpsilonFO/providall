import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Aucun test ne touche le réseau : `fetch` est injecté par option.
    environment: "node",
  },
});
