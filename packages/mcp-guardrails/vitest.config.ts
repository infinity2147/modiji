import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "mcp-guardrails", include: ["test/**/*.test.ts"], environment: "node" },
});
