import type { PrismaClient, Prisma } from "@prisma/client";
import {
  LocalPatchSchema,
  LocalProposalSchema,
  RepositoryLocalizationSourceInputSchema,
  type LocalPatch,
} from "@corely/contracts";
import type { LocalPatchRepository } from "./local-patches";
import {
  LocalSourceDocumentSchema,
  emptyLocalSourceDocument,
  localPostgresProviderKey,
  type LocalSource,
  type LocalSourceRepository,
} from "./local-source";
import { PatchError } from "./patch.errors";
import {
  repositoryLocalizationProviderKey,
  type RepositoryLocalizationSourceRepository,
} from "./repository-localization-source";
export class PrismaLocalPatchRepository
  implements
    LocalPatchRepository,
    LocalSourceRepository,
    RepositoryLocalizationSourceRepository
{
  constructor(private readonly db: PrismaClient) {}
  async find(tenantId: string, id: string) {
    const row = await this.db.localContentPatch.findFirst({
      where: { tenantId, id },
    });
    return row ? LocalPatchSchema.parse(JSON.parse(row.document)) : null;
  }
  async list(
    tenantId: string,
    connections: string[] | null,
    after?: string,
    approved = false,
  ) {
    const rows = await this.db.localContentPatch.findMany({
      where: {
        tenantId,
        ...(connections !== null ? { connectionId: { in: connections } } : {}),
        ...(approved ? { status: "APPROVED" } : {}),
        ...(after ? { id: { gt: after } } : {}),
      },
      orderBy: { id: "asc" },
      take: 21,
    });
    return rows.map((row) => LocalPatchSchema.parse(JSON.parse(row.document)));
  }
  async insert(patch: LocalPatch) {
    await this.db.localContentPatch.createMany({
      data: [
        {
          id: patch.id,
          tenantId: patch.tenantId,
          connectionId: patch.proposal.connectionId,
          revision: patch.revision,
          status: patch.status,
          document: JSON.stringify(patch),
        },
      ],
      skipDuplicates: true,
    });
  }
  async replace(before: LocalPatch, after: LocalPatch) {
    const result = await this.db.localContentPatch.updateMany({
      where: {
        id: before.id,
        tenantId: before.tenantId,
        revision: before.revision,
        document: JSON.stringify(before),
      },
      data: { status: after.status, document: JSON.stringify(after) },
    });
    return result.count === 1;
  }
  async startExecution(before: LocalPatch, after: LocalPatch) {
    if ("kind" in before.proposal) {
      const proposal = before.proposal;
      return this.db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "IntegrationConnection"
          WHERE id=${proposal.connectionId}
            AND "tenantId"=${before.tenantId}
            AND "providerKey"=${repositoryLocalizationProviderKey}
            AND status='active'
          FOR UPDATE`;
        if (locked.length !== 1)
          throw new PatchError(
            404,
            "SOURCE_NOT_FOUND",
            "Repository source not found.",
          );
        const source = await tx.integrationConnection.findFirst({
          where: {
            id: proposal.connectionId,
            tenantId: before.tenantId,
            providerKey: repositoryLocalizationProviderKey,
            status: "active",
          },
          select: { configJson: true },
        });
        const config = source
          ? RepositoryLocalizationSourceInputSchema.parse(source.configJson)
          : null;
        if (
          !config ||
          config.repositoryUrl !== proposal.repositoryUrl ||
          config.baseBranch !== proposal.baseBranch ||
          config.baseLocale !== proposal.baseLocale ||
          proposal.operations.some(
            (op) =>
              !config.locales.includes(op.targetLocale) ||
              config.paths[op.sourceLocale] !== op.sourcePath ||
              config.paths[op.targetLocale] !== op.targetPath,
          )
        )
          throw new PatchError(
            409,
            "STALE_SOURCE_CONFIGURATION",
            "Repository localization source changed after approval.",
          );
        const result = await tx.localContentPatch.updateMany({
          where: {
            id: before.id,
            tenantId: before.tenantId,
            revision: before.revision,
            document: JSON.stringify(before),
          },
          data: { status: after.status, document: JSON.stringify(after) },
        });
        return result.count === 1;
      });
    }
    const proposal = LocalProposalSchema.parse(before.proposal);
    return this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "IntegrationConnection"
        WHERE id=${proposal.connectionId}
          AND "tenantId"=${before.tenantId}
          AND "providerKey"=${localPostgresProviderKey}
          AND status='active'
        FOR UPDATE`;
      if (locked.length !== 1)
        throw new PatchError(404, "SOURCE_NOT_FOUND", "Source not found.");
      const source = await tx.integrationConnection.findFirst({
        where: {
          id: proposal.connectionId,
          tenantId: before.tenantId,
          providerKey: localPostgresProviderKey,
          status: "active",
        },
        select: { configJson: true },
      });
      const document = source
        ? LocalSourceDocumentSchema.parse(source.configJson)
        : null;
      if (
        !document?.schema ||
        document.schema.version !== proposal.schemaVersion ||
        document.configuration.version !== proposal.configurationVersion
      )
        throw new PatchError(
          409,
          "STALE_SOURCE_CONFIGURATION",
          "The source schema or configuration changed after approval.",
        );
      const result = await tx.localContentPatch.updateMany({
        where: {
          id: before.id,
          tenantId: before.tenantId,
          revision: before.revision,
          document: JSON.stringify(before),
        },
        data: { status: after.status, document: JSON.stringify(after) },
      });
      return result.count === 1;
    });
  }
  private mapLocalSource(row: {
    id: string;
    tenantId: string;
    displayName: string | null;
    configJson: unknown;
  }): LocalSource {
    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.displayName ?? row.id,
      document: LocalSourceDocumentSchema.parse(row.configJson),
    };
  }
  async provisionLocalSourceToken(input: {
    tenantId: string;
    ownerUserId: string;
    keyHash: string;
    sourceId: string;
  }) {
    await this.db.$transaction(async (tx) => {
      await tx.integrationConnection.create({
        data: {
          id: input.sourceId,
          tenantId: input.tenantId,
          providerKey: localPostgresProviderKey,
          authMethod: "local-client",
          displayName: "Local PostgreSQL source",
          configJson: emptyLocalSourceDocument() as Prisma.InputJsonValue,
        },
      });
      await tx.apiKey.create({
        data: {
          tenantId: input.tenantId,
          ownerUserId: input.ownerUserId,
          keyHash: input.keyHash,
          name: `Local PatchCTL client ${input.sourceId}`,
          scopes: ["read", "propose"],
          connectionIds: [input.sourceId],
        },
      });
    });
  }
  async provisionRepositoryLocalizationToken(input: {
    tenantId: string;
    ownerUserId: string;
    keyHash: string;
    sourceId: string;
    configuration: Parameters<
      RepositoryLocalizationSourceRepository["provisionRepositoryLocalizationToken"]
    >[0]["configuration"];
  }) {
    await this.db.$transaction(async (tx) => {
      await tx.integrationConnection.create({
        data: {
          id: input.sourceId,
          tenantId: input.tenantId,
          providerKey: repositoryLocalizationProviderKey,
          authMethod: "local-client",
          displayName: input.configuration.name,
          configJson: input.configuration as Prisma.InputJsonValue,
        },
      });
      await tx.apiKey.create({
        data: {
          tenantId: input.tenantId,
          ownerUserId: input.ownerUserId,
          keyHash: input.keyHash,
          name: `Repository localization client ${input.sourceId}`,
          scopes: ["read", "propose"],
          connectionIds: [input.sourceId],
        },
      });
    });
  }
  async findRepositoryLocalizationSource(tenantId: string, sourceId: string) {
    const row = await this.db.integrationConnection.findFirst({
      where: {
        id: sourceId,
        tenantId,
        providerKey: repositoryLocalizationProviderKey,
        status: "active",
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      tenantId: row.tenantId,
      configuration: RepositoryLocalizationSourceInputSchema.parse(
        row.configJson,
      ),
    };
  }
  async findLocalSource(tenantId: string, sourceId: string) {
    const row = await this.db.integrationConnection.findFirst({
      where: {
        id: sourceId,
        tenantId,
        providerKey: localPostgresProviderKey,
        status: "active",
      },
    });
    return row ? this.mapLocalSource(row) : null;
  }
  async listLocalSources(tenantId: string, sourceIds: string[] | null) {
    const rows = await this.db.integrationConnection.findMany({
      where: {
        tenantId,
        providerKey: localPostgresProviderKey,
        status: "active",
        ...(sourceIds !== null ? { id: { in: sourceIds } } : {}),
      },
      orderBy: { id: "asc" },
    });
    return rows.map((row) => this.mapLocalSource(row));
  }
  async replaceLocalSource(before: LocalSource, after: LocalSource) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id=${before.id} AND "tenantId"=${before.tenantId} FOR UPDATE`;
      const current = await tx.integrationConnection.findFirst({
        where: {
          id: before.id,
          tenantId: before.tenantId,
          providerKey: localPostgresProviderKey,
          status: "active",
        },
      });
      if (
        !current ||
        current.displayName !== before.name ||
        JSON.stringify(LocalSourceDocumentSchema.parse(current.configJson)) !==
          JSON.stringify(before.document)
      )
        return false;
      const activeLocalPatches = await tx.localContentPatch.findMany({
        where: {
          tenantId: before.tenantId,
          connectionId: before.id,
          status: "APPROVED",
        },
        select: { document: true },
      });
      if (
        activeLocalPatches.some((row) => {
          const patch = LocalPatchSchema.parse(JSON.parse(row.document));
          return patch.events.at(-1)?.event === "PATCH_APPLY_STARTED";
        }) ||
        (await tx.contentPatch.count({
          where: {
            tenantId: before.tenantId,
            sourceId: before.id,
            state: "applying",
          },
        })) > 0
      )
        throw new PatchError(
          409,
          "SOURCE_BUSY",
          "Finish or recover the applying patch before changing this source.",
        );
      const result = await tx.integrationConnection.updateMany({
        where: {
          id: before.id,
          tenantId: before.tenantId,
          providerKey: localPostgresProviderKey,
          status: "active",
        },
        data: {
          displayName: after.name,
          configJson: after.document as Prisma.InputJsonValue,
        },
      });
      return result.count === 1;
    });
  }
}
