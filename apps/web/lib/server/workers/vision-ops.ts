/**
 * Operations of the vision worker (vision.worker.ts): `prepare` decodes an uploaded frame and plans its
 * read (perception/prepare.ts). The worker returns the read without what the main thread already holds
 * or must build itself: the output schema (a zod object, not transferable; rebuilt from the domain and
 * screen profile) and the context it was given (domain, profile, previous reading).
 */
import { z } from "zod";
import {
  ActionIdSchema,
  DomainConfigSchema,
  FeatureIdSchema,
  FeatureValueSchema,
  UnknownSchema,
} from "@vashistha/core";
import { CLAUDE_MODELS, type ClaudeModel } from "@vashistha/core/server";
import type { Thumbnail } from "@vashistha/perception";
import type { CaseSnapshot, ScreenProfile } from "@vashistha/perception/extraction";
import type { RpcOps } from "./rpc";

/** A frame plans in tens to hundreds of milliseconds; past this the worker is presumed wedged. */
const PREPARE_TIMEOUT_MS = 30_000;

const RectSchema = z.strictObject({ x: z.int(), y: z.int(), width: z.int().positive(), height: z.int().positive() });
const EncodedImageSchema = z.strictObject({ base64Png: z.string().min(1), width: z.int().positive(), height: z.int().positive() });
const ThumbnailSchema: z.ZodType<Thumbnail> = z.strictObject({ gray: z.instanceof(Float32Array), hash: z.bigint(), width: z.int(), height: z.int() });
const ScreenProfileSchema: z.ZodType<ScreenProfile> = z.strictObject({ editableFields: z.array(FeatureIdSchema).readonly(), chrome: z.array(z.string()).readonly() });
const CaseSnapshotSchema: z.ZodType<CaseSnapshot> = z.strictObject({
  caseId: z.string().nullable(),
  fields: z.record(FeatureIdSchema, FeatureValueSchema),
  committed: z.union([ActionIdSchema, z.null(), UnknownSchema]),
  thumbnail: ThumbnailSchema,
  fullReadAt: z.number(),
  conceptsRead: z.boolean(),
  caseVotes: z.record(z.string(), z.number()),
  caseTitle: z.string().nullable(),
});

const ContentBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("image"),
    source: z.strictObject({ type: z.literal("base64"), media_type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]), data: z.string().min(1) }),
  }),
]);
const MODELS: readonly ClaudeModel[] = Object.values(CLAUDE_MODELS);
const RequestSchema = z.strictObject({
  model: z.enum(MODELS),
  system: z.string(),
  messages: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), content: z.union([z.string(), z.array(ContentBlockSchema)]) })),
  maxTokens: z.int().positive(),
  cacheSystem: z.boolean().exactOptional(),
});
const PlannedBase = { request: RequestSchema, thumbnail: ThumbnailSchema, switchPossible: z.boolean() };

export const VISION_OPS = {
  prepare: {
    input: z.strictObject({
      domain: DomainConfigSchema,
      profile: ScreenProfileSchema,
      previous: CaseSnapshotSchema.nullable(),
      frameSeq: z.int().nonnegative(),
      captureTime: z.number(),
      sessionEpoch: z.int().nonnegative(),
      frame: EncodedImageSchema.extend({ sourceWidth: z.int().positive(), sourceHeight: z.int().positive() }),
      crop: EncodedImageSchema.extend({ rect: RectSchema }).nullable(),
    }),
    output: z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("full"), ...PlannedBase }),
      z.strictObject({ mode: z.literal("refresh"), ...PlannedBase }),
      z.strictObject({ mode: z.literal("local"), rect: RectSchema, ...PlannedBase }),
    ]),
    timeoutMs: PREPARE_TIMEOUT_MS,
  },
} satisfies RpcOps;
