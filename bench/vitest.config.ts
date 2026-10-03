import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    // `server-only` throws outside a React Server Components build; the bench reads the KYC oracle directly.
    alias: [{ find: /^server-only$/, replacement: fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)) }],
  },
  test: { name: "bench", include: ["test/**/*.test.ts"], environment: "node", testTimeout: 120_000 },
});
