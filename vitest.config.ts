import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*", "scripts", "apps/web/vitest.bundle.config.ts"],
    // web-bundle scans a production build, so plain `vitest run` skips it; a CLI `--project` filter
    // replaces this default (`pnpm test:bundle` runs `vitest run --project web-bundle`).
    project: ["!web-bundle"],
  },
});
