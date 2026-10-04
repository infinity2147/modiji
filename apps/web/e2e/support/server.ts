/** Per-spec server facts (playwright.config.ts gives every spec file its own server and DATA_DIR). */
import { test } from "@playwright/test";
import { z } from "zod";

const ProjectMetadataSchema = z.object({ dataDir: z.string().min(1) });

/** The DATA_DIR of the server this spec runs against. */
export function serverDataDir(): string {
  return ProjectMetadataSchema.parse(test.info().project.metadata).dataDir;
}
