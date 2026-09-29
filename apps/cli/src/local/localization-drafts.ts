import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RepositoryLocalizationOperationSchema } from "@corely/contracts";
import { LocalError } from "./errors.js";
import { tenantIdSchema } from "./config.js";

const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const LocalizationDraftSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: tenantIdSchema,
    sourceId: z.string().uuid(),
    repositoryUrl: z.string().min(1).max(500),
    baseBranch: z.string().min(1).max(100),
    baseLocale: z.string().min(2).max(30),
    baseCommitSha: revision,
    title: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    status: z.enum([
      "DRAFT",
      "SUBMITTED",
      "APPROVED",
      "REJECTED",
      "APPLIED",
      "FAILED",
      "CONFLICT",
    ]),
    submittedServer: z
      .object({
        url: z.string().url(),
        tenantId: z.string(),
        connectionId: z.string().uuid(),
      })
      .strict()
      .optional(),
    operations: z.array(RepositoryLocalizationOperationSchema).max(100),
  })
  .strict();
export type LocalizationDraft = z.infer<typeof LocalizationDraftSchema>;

export function startLocalizationDraft(input: {
  tenantId: string;
  sourceId: string;
  repositoryUrl: string;
  baseBranch: string;
  baseLocale: string;
  baseCommitSha: string;
  title: string;
}): LocalizationDraft {
  return LocalizationDraftSchema.parse({
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "DRAFT",
    operations: [],
  });
}

function file(directory: string, tenantId: string) {
  return join(directory, `${tenantId}-localization-draft.json`);
}

export async function readLocalizationDraft(
  directory: string,
  tenantId: string,
): Promise<LocalizationDraft> {
  try {
    const path = file(directory, tenantId);
    if ((await stat(path)).size > 2_000_000) throw new Error();
    const draft = LocalizationDraftSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
    if (draft.tenantId !== tenantId) throw new Error();
    return draft;
  } catch (caught) {
    if (caught instanceof Error && "code" in caught && caught.code === "ENOENT")
      throw new LocalError(
        "NO_ACTIVE_PATCH",
        "Run patchctl localization start first.",
      );
    throw new LocalError(
      "INVALID_PATCH",
      "Localization draft is invalid or unreadable.",
    );
  }
}

export async function withLocalizationDraftLock<T>(
  directory: string,
  tenantId: string,
  action: (save: (draft: LocalizationDraft) => Promise<void>) => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, `${tenantId}-localization-draft.lock`);
  let handle;
  try {
    handle = await open(lock, "wx", 0o600);
  } catch {
    throw new LocalError(
      "PATCH_BUSY",
      "Another command is editing this localization draft.",
    );
  }
  try {
    return await action(async (draft) => {
      const parsed = LocalizationDraftSchema.parse(draft);
      if (parsed.tenantId !== tenantId)
        throw new LocalError("INVALID_PATCH", "Patch Tenant does not match.");
      const text = JSON.stringify(parsed, null, 2) + "\n";
      if (Buffer.byteLength(text) > 2_000_000)
        throw new LocalError("PATCH_TOO_LARGE", "Patch exceeds 2 MB.");
      const temporary = join(directory, `${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
        await rename(temporary, file(directory, tenantId));
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
  } finally {
    await handle.close();
    await unlink(lock);
  }
}
