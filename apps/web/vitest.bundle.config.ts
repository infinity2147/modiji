import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "web-bundle",
    include: ["test/**/*.bundle.test.ts"],
    environment: "node",
  },
});
