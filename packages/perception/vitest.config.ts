import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    // `server-only` throws outside a React Server Components build; the prompt-guard test imports the KYC oracle marker.
    alias: [{ find: /^server-only$/, replacement: fileURLToPath(new URL("../core/node_modules/server-only/empty.js", import.meta.url)) }],
  },
  test: { name: "perception", include: ["test/**/*.test.ts"], environment: "node" },
});
