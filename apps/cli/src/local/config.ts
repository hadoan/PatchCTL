import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { LocalError } from "./errors.js";
import { RepositoryLocalizationSourceSchema } from "./repository-localization.js";

const repositoryLocalizationSourcesSchema = z
  .array(RepositoryLocalizationSourceSchema)
  .max(20)
  .superRefine((sources, context) => {
    if (new Set(sources.map((source) => source.id)).size !== sources.length)
      context.addIssue({
        code: "custom",
        message:
          "Repository localization source IDs must be unique per Tenant.",
      });
  });

export const tenantIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
  .refine(
    (value) => !["__proto__", "constructor", "prototype"].includes(value),
  );
const selectionSchema = z
  .object({
    schemaName: z.string().min(1),
    tableName: z.string().min(1),
    columns: z.array(z.string().min(1)).min(1),
  })
  .strict();
const sourceMetadataSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    type: z.literal("postgres"),
    credentialRef: z.string(),
    legacyCredentialRef: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\/database$/)
      .optional(),
  })
  .strict()
  .refine((source) => source.credentialRef === `patchctl/source/${source.id}`, {
    path: ["credentialRef"],
    message: "Credential reference must belong to its source ID.",
  });
const serverSchema = z
  .object({
    url: z.string().url(),
    tenantId: z.string(),
    connectionId: z.string().uuid(),
  })
  .strict();
const tenantConfigFields = {
  resources: z.array(selectionSchema),
  databaseId: z.string().uuid().optional(),
  server: serverSchema.optional(),
};
const tenantConfigSchema = z
  .object({
    source: sourceMetadataSchema,
    ...tenantConfigFields,
  })
  .strict();
const legacyTenantConfigSchema = z
  .object({
    source: sourceMetadataSchema.optional(),
    ...tenantConfigFields,
  })
  .strict();
export type Selection = z.infer<typeof selectionSchema>;
export type SourceMetadata = z.infer<typeof sourceMetadataSchema>;
export const configSchema = z
  .object({
    currentTenant: tenantIdSchema.optional(),
    tenants: z.record(tenantIdSchema, tenantConfigSchema),
    repositoryLocalization: z
      .record(tenantIdSchema, repositoryLocalizationSourcesSchema)
      .optional(),
  })
  .strict();
const legacyConfigSchema = z
  .object({
    currentTenant: tenantIdSchema.optional(),
    tenants: z.record(tenantIdSchema, legacyTenantConfigSchema),
    repositoryLocalization: z
      .record(tenantIdSchema, repositoryLocalizationSourcesSchema)
      .optional(),
  })
  .strict();
export type LocalConfig = z.infer<typeof configSchema>;

export function configuredRepositoryLocalization(
  config: LocalConfig,
  tenantId: string,
  sourceId: string,
) {
  const source = config.repositoryLocalization?.[tenantId]?.find(
    (candidate) => candidate.id === sourceId,
  );
  if (!source)
    throw new LocalError(
      "SOURCE_NOT_FOUND",
      "Repository localization source is not configured for this Tenant.",
    );
  return source;
}

export function sourceMetadata(
  _tenantId: string,
  local: LocalConfig["tenants"][string],
): SourceMetadata {
  return local.source;
}

export function credentialReference(
  _tenantId: string,
  local: LocalConfig["tenants"][string],
): string {
  return local.source.credentialRef;
}

export function legacyCredentialReference(
  local: LocalConfig["tenants"][string],
): string | undefined {
  return local.source.legacyCredentialRef;
}

export function configDirectory(env: NodeJS.ProcessEnv): string {
  return env.PATCHCTL_HOME ?? join(homedir(), ".patchctl");
}
export async function readConfig(directory: string): Promise<LocalConfig> {
  try {
    const stored = legacyConfigSchema.parse(
      JSON.parse(await readFile(join(directory, "config.json"), "utf8")),
    );
    let migrated = false;
    for (const [tenantId, local] of Object.entries(stored.tenants)) {
      if (local.source) continue;
      const sourceId = local.databaseId ?? randomUUID();
      local.source = {
        id: sourceId,
        name: tenantId,
        type: "postgres",
        credentialRef: `patchctl/source/${sourceId}`,
        legacyCredentialRef: `${tenantId}/database`,
      };
      migrated = true;
    }
    const config = configSchema.parse(stored);
    if (migrated) await writeConfig(directory, config);
    return config;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { tenants: {} };
    if (error instanceof LocalError) throw error;
    throw new LocalError(
      "INVALID_CONFIG",
      "Local configuration is invalid or unreadable.",
    );
  }
}
export async function writeConfig(
  directory: string,
  config: LocalConfig,
): Promise<void> {
  // Strict schema rejects accidental secret properties before touching the disk.
  const parsed = configSchema.safeParse(config);
  if (!parsed.success)
    throw new LocalError(
      "INVALID_CONFIG",
      "Only non-secret configuration metadata is accepted.",
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(parsed.data, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, join(directory, "config.json"));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
