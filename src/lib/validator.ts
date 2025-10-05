import { z } from "zod";

export const TargetSchema = z.object({
  uri: z.string().min(1, "uri required"),
  database: z.string().min(1, "database required")
});

const PartialFilterAllowedOps = z.union([
  z.literal("$exists"),
  z.literal("$eq"),
  z.literal("$in"),
  z.literal("$gt"),
  z.literal("$gte"),
  z.literal("$lt"),
  z.literal("$lte"),
  z.literal("$ne"),
]);

export const CreateCollectionSchema = z.object({
  type: z.literal("createCollection"),
  collection: z.string().min(1),
  options: z.record(z.string(), z.any()).optional()
});

export const CreateIndexSchema = z.object({
  type: z.literal("createIndex"),
  collection: z.string().min(1),
  spec: z
    .record(z.string(), z.union([z.number(), z.literal(1), z.literal(-1)]))
    .refine(v => Object.keys(v).length > 0, "spec required"),
  options: z.object({
    name: z.string().min(1),
    unique: z.boolean().optional(),
    partialFilterExpression: z.record(z.string(), z.any()).optional()
  }).optional()
}).superRefine((data, ctx) => {
  const pfe = data.options?.partialFilterExpression as Record<string, any> | undefined;
  if (!pfe) return;
  const isAllowed = Object.values(pfe).every(v => {
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      return keys.every(k => PartialFilterAllowedOps.safeParse(k).success);
    }
    return true;
  });
  if (!isAllowed) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "partialFilterExpression contains disallowed operators" });
});

export const OperationSchema = z.discriminatedUnion("type", [
  CreateCollectionSchema,
  CreateIndexSchema
]);

export const ChangeRequestSchema = z.object({
  changeId: z.string().min(1).optional(),
  target: TargetSchema,
  operation: OperationSchema,
  metadata: z.record(z.string(), z.any()).optional()
});
