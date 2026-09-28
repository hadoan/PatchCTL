import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const LocalValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const record = z.record(z.string(), LocalValueSchema);
export const LocalOperationSchema = z
  .object({
    id: z.string().uuid(),
    resource: z.string().min(1),
    recordId: z.string().min(1),
    operation: z.literal("UPDATE"),
    before: record,
    after: record,
    expectedVersion: z.object({ snapshotHash: hash }).strict(),
    schemaHash: hash,
  })
  .strict();
export const LocalFieldSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum([
      "string",
      "text",
      "number",
      "boolean",
      "date",
      "datetime",
      "enum",
      "relation",
      "unsupported",
    ]),
    nullable: z.boolean(),
    readonly: z.boolean(),
    pgType: z.string(),
    enumValues: z.array(z.string()).optional(),
    relation: z
      .object({ resource: z.string(), column: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export const LocalResourceSchema = z
  .object({
    name: z.string(),
    schemaName: z.string(),
    tableName: z.string(),
    primaryKey: z.string().nullable(),
    fields: z.array(LocalFieldSchema),
    constraints: z.array(
      z
        .object({
          name: z.string(),
          kind: z.string(),
          definition: z.string(),
          columns: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();
export const LocalProposalSchema = z
  .object({
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
    databaseId: z.string().uuid(),
    schemaVersion: hash,
    configurationVersion: z.number().int().nonnegative(),
    title: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    operations: z.array(LocalOperationSchema).min(1).max(100),
    resources: z.array(LocalResourceSchema).min(1).max(100),
  })
  .strict()
  .superRefine((p, ctx) => {
    const records = p.operations.map((op) =>
      JSON.stringify([op.resource, op.recordId]),
    );
    if (
      new Set(records).size !== records.length ||
      new Set(p.operations.map((op) => op.id)).size !== p.operations.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate operations." });
    if (new Set(p.resources.map((r) => r.name)).size !== p.resources.length)
      ctx.addIssue({ code: "custom", message: "Duplicate resources." });
    for (const op of p.operations) {
      const resource = p.resources.find((r) => r.name === op.resource);
      if (
        !resource ||
        !resource.primaryKey ||
        new Set(resource.fields.map((f) => f.name)).size !==
          resource.fields.length
      ) {
        ctx.addIssue({ code: "custom", message: "Invalid resource metadata." });
        continue;
      }
      const before = Object.keys(op.before).sort(),
        after = Object.keys(op.after).sort();
      if (
        JSON.stringify(before) !== JSON.stringify(after) ||
        !before.includes(resource.primaryKey)
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid before/after shape.",
        });
      let changed = false;
      for (const name of after) {
        const field = resource.fields.find((f) => f.name === name);
        if (!field || field.type === "unsupported")
          ctx.addIssue({ code: "custom", message: "Unselected field." });
        const changedField = op.before[name] !== op.after[name];
        if (changedField) {
          changed = true;
          if (!field || field.readonly || name === resource.primaryKey)
            ctx.addIssue({ code: "custom", message: "Readonly field." });
        }
      }
      if (!changed)
        ctx.addIssue({ code: "custom", message: "Empty operation." });
    }
    if (
      p.resources.some(
        (r) => !p.operations.some((op) => op.resource === r.name),
      )
    )
      ctx.addIssue({ code: "custom", message: "Unrelated resource metadata." });
  });
const locale = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
const repositoryPath = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.json$/)
  .refine((value) =>
    value
      .split("/")
      .every((part) => part !== "." && part !== ".." && part !== ""),
  );
export const RepositoryLocalizationSourceInputSchema = z
  .object({
    type: z.literal("repository-localization"),
    name: z.string().trim().min(1).max(100),
    repositoryUrl: z
      .string()
      .max(500)
      .refine(
        (value) =>
          /^https:\/\/[^\s]+$/.test(value) ||
          /^ssh:\/\/[^\s]+$/.test(value) ||
          /^git@[^\s:]+:[^\s]+$/.test(value),
      ),
    baseBranch: z
      .string()
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
      .refine((value) => !value.includes("..") && !value.includes("//")),
    baseLocale: locale,
    locales: z.array(locale).min(2).max(20),
    paths: z.record(locale, repositoryPath),
  })
  .strict()
  .superRefine((source, context) => {
    if (
      new Set(source.locales).size !== source.locales.length ||
      !source.locales.includes(source.baseLocale) ||
      Object.keys(source.paths).length !== source.locales.length ||
      source.locales.some((item) => !source.paths[item]) ||
      new Set(Object.values(source.paths)).size !== source.locales.length
    )
      context.addIssue({
        code: "custom",
        message: "Locale mapping must be unique and complete.",
      });
  });
export type RepositoryLocalizationSourceInput = z.infer<
  typeof RepositoryLocalizationSourceInputSchema
>;
export const RepositoryLocalizationOperationSchema = z
  .object({
    id: z.string().uuid(),
    key: z.string().min(1).max(512),
    sourceLocale: locale,
    sourceText: z.string().max(100_000),
    sourceRevision: hash,
    sourcePath: repositoryPath,
    targetLocale: locale,
    targetBefore: z.string().max(100_000).nullable(),
    targetAfter: z.string().min(1).max(100_000),
    targetPath: repositoryPath,
    targetBlobSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    translationStatus: z.enum(["translated", "missing", "stale", "unverified"]),
    recordedSourceRevision: hash.nullable(),
  })
  .strict();
export const RepositoryLocalizationProposalSchema = z
  .object({
    kind: z.literal("repository-localization"),
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
    repositoryUrl: z.string().min(1).max(500),
    baseBranch: z.string().min(1).max(100),
    baseLocale: locale,
    baseCommitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    title: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    operations: z.array(RepositoryLocalizationOperationSchema).min(1).max(100),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (
      new Set(
        proposal.operations.map((op) =>
          JSON.stringify([op.targetLocale, op.key]),
        ),
      ).size !== proposal.operations.length ||
      new Set(proposal.operations.map((op) => op.id)).size !==
        proposal.operations.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate localization operations.",
      });
    for (const operation of proposal.operations) {
      if (
        operation.sourceLocale !== proposal.baseLocale ||
        operation.targetLocale === proposal.baseLocale ||
        operation.targetBefore === operation.targetAfter
      )
        context.addIssue({
          code: "custom",
          message: "Invalid localization operation.",
        });
      const expectedStatus =
        operation.targetBefore === null || operation.targetBefore.trim() === ""
          ? "missing"
          : operation.recordedSourceRevision === null
            ? "unverified"
            : operation.recordedSourceRevision === operation.sourceRevision
              ? "translated"
              : "stale";
      if (operation.translationStatus !== expectedStatus)
        context.addIssue({
          code: "custom",
          message: "Localization status does not match recorded revisions.",
        });
    }
  });
export const LocalPatchProposalSchema = z.union([
  LocalProposalSchema,
  RepositoryLocalizationProposalSchema,
]);
export const LocalStatusSchema = z.enum([
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "APPLIED",
  "FAILED",
  "CONFLICT",
]);
const actor = z
  .object({ id: z.string(), kind: z.enum(["human", "agent"]) })
  .strict();
export const LocalPatchSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string(),
    revision: hash,
    status: LocalStatusSchema,
    proposal: LocalPatchProposalSchema,
    creator: actor,
    reviewerId: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    appliedAt: z.string().nullable(),
    failureCode: z.string().nullable(),
    events: z.array(
      z.object({ event: z.string(), actor, timestamp: z.string() }).strict(),
    ),
  })
  .strict();
export const LocalDecisionSchema = z
  .object({ revision: hash, decision: z.enum(["APPROVED", "REJECTED"]) })
  .strict();
export const LocalResultSchema = z
  .object({
    revision: hash,
    status: z.enum(["STARTED", "APPLIED", "FAILED", "CONFLICT"]),
    code: z
      .enum([
        "PATCH_CONFLICT",
        "SCHEMA_CHANGED",
        "INVALID_VALUE",
        "FIELD_READONLY",
        "RESOURCE_NOT_FOUND",
        "RELATION_NOT_FOUND",
        "DATABASE_UNAVAILABLE",
        "APPLY_FAILED",
      ])
      .optional(),
  })
  .strict();
export type LocalProposal = z.infer<typeof LocalProposalSchema>;
export type LocalPatchProposal = z.infer<typeof LocalPatchProposalSchema>;
export type RepositoryLocalizationProposal = z.infer<
  typeof RepositoryLocalizationProposalSchema
>;
export type LocalPatch = z.infer<typeof LocalPatchSchema>;
export type LocalExecutionResult = z.infer<typeof LocalResultSchema>;
export const LocalPatchListSchema = z
  .object({
    items: z.array(LocalPatchSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const LocalClientTokenSchema = z
  .object({
    token: z.string(),
    connectionId: z.string().uuid(),
    tenantId: z.string(),
  })
  .strict();
export function canonicalLocal(value: unknown): string {
  function stable(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(stable);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, item]) => [k, stable(item)]),
      );
    return v;
  }
  return JSON.stringify(stable(value));
}
