import { configDefaults, defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    // `server-only` throws outside a React Server Components build; unit tests import server modules directly.
    alias: { "server-only": new URL("./test/support/empty-module.ts", import.meta.url).pathname },
  },
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
    // Bundle tests need a production build; they run in the "web-bundle" project via `pnpm test:bundle`.
    exclude: [...configDefaults.exclude, "test/**/*.bundle.test.ts"],
    environment: "node",
  },
});
