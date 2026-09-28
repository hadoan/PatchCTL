import { createHash } from "node:crypto";
import { localizationSourceRevision } from "@patchctl/localization";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalLocal,
  canonicalSourceResources,
  type LocalPatch,
  type LocalProposal,
  type SourceDiscoveredResource,
} from "@corely/contracts";
import {
  PatchError,
  configureLocalSourceSchema,
  createLocalClientToken,
  decideLocalPatch,
  emptyLocalSourceDocument,
  getEffectiveLocalSourceSchema,
  reportLocalExecution,
  submitLocalPatch,
  syncLocalSourceSchema,
  type Actor,
  type LocalPatchRepository,
  type LocalSource,
  type LocalSourceRepository,
  type RepositoryLocalizationSource,
  type RepositoryLocalizationSourceRepository,
} from "../index";

const sourceId = "11111111-1111-4111-8111-111111111111";
const patchId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const resources: SourceDiscoveredResource[] = [
  {
    name: "public.articles",
    schemaName: "public",
    tableName: "articles",
    primaryKey: "id",
    fields: [
      {
        name: "id",
        type: "number",
        nullable: false,
        primaryKey: true,
        databaseReadonly: true,
      },
      {
        name: "title",
        type: "text",
        nullable: false,
        primaryKey: false,
        databaseReadonly: false,
      },
    ],
  },
];
const proposalResource: LocalProposal["resources"][number] = {
  name: "public.articles",
  schemaName: "public",
  tableName: "articles",
  primaryKey: "id",
  fields: [
    {
      name: "id",
      type: "number",
      nullable: false,
      readonly: true,
      pgType: "int4",
    },
    {
      name: "title",
      type: "text",
      nullable: false,
      readonly: false,
      pgType: "text",
    },
  ],
  constraints: [],
};
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalLocal(value)).digest("hex");
const schemaVersion = (value: SourceDiscoveredResource[]) =>
  createHash("sha256").update(canonicalSourceResources(value)).digest("hex");
const agent: Actor = {
  tenantId: "tenant-a",
  id: "agent-a",
  ownerUserId: "owner-a",
  kind: "agent",
  permissions: ["read", "propose"],
  connectionIds: [sourceId],
};
const human: Actor = {
  tenantId: "tenant-a",
  id: "owner-a",
  ownerUserId: "owner-a",
  kind: "human",
  permissions: ["read", "propose", "review", "apply", "configure"],
  connectionIds: null,
};

class MemoryRepository
  implements
    LocalPatchRepository,
    LocalSourceRepository,
    RepositoryLocalizationSourceRepository
{
  readonly patches = new Map<string, LocalPatch>();
  readonly localizationSources = new Map<
    string,
    RepositoryLocalizationSource
  >();
  readonly sources = new Map<string, LocalSource>([
    [
      sourceId,
      {
        id: sourceId,
        tenantId: "tenant-a",
        name: "Local PostgreSQL source",
        document: emptyLocalSourceDocument(),
      },
    ],
  ]);
  readonly start = vi.fn();

  async find(tenantId: string, id: string) {
    const patch = this.patches.get(id);
    return patch?.tenantId === tenantId ? structuredClone(patch) : null;
  }
  async list() {
    return [...this.patches.values()].map((patch) => structuredClone(patch));
  }
  async insert(patch: LocalPatch) {
    if (!this.patches.has(patch.id))
      this.patches.set(patch.id, structuredClone(patch));
  }
  async replace(before: LocalPatch, after: LocalPatch) {
    const current = this.patches.get(before.id);
    if (JSON.stringify(current) !== JSON.stringify(before)) return false;
    this.patches.set(after.id, structuredClone(after));
    return true;
  }
  async startExecution(before: LocalPatch, after: LocalPatch) {
    this.start(before, after);
    if ("kind" in before.proposal) return this.replace(before, after);
    const source = this.sources.get(before.proposal.connectionId);
    if (
      source?.document.schema?.version !== before.proposal.schemaVersion ||
      source.document.configuration.version !==
        before.proposal.configurationVersion
    )
      throw new PatchError(
        409,
        "STALE_SOURCE_CONFIGURATION",
        "The source schema or configuration changed after approval.",
      );
    return this.replace(before, after);
  }
  async provisionLocalSourceToken() {}
  async provisionRepositoryLocalizationToken(
    input: Parameters<
      RepositoryLocalizationSourceRepository["provisionRepositoryLocalizationToken"]
    >[0],
  ) {
    this.localizationSources.set(input.sourceId, {
      id: input.sourceId,
      tenantId: input.tenantId,
      configuration: input.configuration,
    });
  }
  async findRepositoryLocalizationSource(tenantId: string, id: string) {
    const source = this.localizationSources.get(id);
    return source?.tenantId === tenantId ? structuredClone(source) : null;
  }
  async findLocalSource(tenantId: string, id: string) {
    const source = this.sources.get(id);
    return source?.tenantId === tenantId ? structuredClone(source) : null;
  }
  async listLocalSources(tenantId: string, ids: string[] | null) {
    return [...this.sources.values()]
      .filter(
        (source) =>
          source.tenantId === tenantId &&
          (ids === null || ids.includes(source.id)),
      )
      .map((source) => structuredClone(source));
  }
  async replaceLocalSource(before: LocalSource, after: LocalSource) {
    const current = this.sources.get(before.id);
    if (JSON.stringify(current) !== JSON.stringify(before)) return false;
    this.sources.set(after.id, structuredClone(after));
    return true;
  }
}

async function configuredRepository(writable = true, managed = true) {
  const repository = new MemoryRepository();
  await syncLocalSourceSchema(
    {
      name: "Editorial database",
      schemaVersion: schemaVersion(resources),
      resources,
    },
    agent,
    repository,
    sourceId,
  );
  await configureLocalSourceSchema(
    {
      expectedVersion: 0,
      resources: [
        {
          name: "public.articles",
          managed,
          fields: [
            { name: "id", writable: false },
            { name: "title", writable: managed && writable },
          ],
        },
      ],
    },
    human,
    repository,
    sourceId,
  );
  return repository;
}

async function proposal(repository: MemoryRepository): Promise<LocalProposal> {
  const effective = await getEffectiveLocalSourceSchema(
    agent,
    repository,
    sourceId,
  );
  return {
    id: patchId,
    connectionId: sourceId,
    databaseId: "44444444-4444-4444-8444-444444444444",
    schemaVersion: effective.schemaVersion,
    configurationVersion: effective.configurationVersion,
    title: "Update article title",
    createdAt: "2026-09-07T00:00:00.000Z",
    operations: [
      {
        id: operationId,
        resource: proposalResource.name,
        recordId: "1",
        operation: "UPDATE",
        before: { id: 1, title: "Before" },
        after: { id: 1, title: "After" },
        expectedVersion: { snapshotHash: "a".repeat(64) },
        schemaHash: hash(proposalResource),
      },
    ],
    resources: [proposalResource],
  };
}

describe("local patch source policy", () => {
  it("accepts a proposal bound to the current managed and writable schema", async () => {
    const repository = await configuredRepository();
    const submitted = await submitLocalPatch(
      await proposal(repository),
      agent,
      repository,
      repository,
    );
    expect(submitted.status).toBe("SUBMITTED");
  });

  it("rejects direct metadata claims for unmanaged or read-only fields", async () => {
    for (const [writable, managed, code] of [
      [false, true, "FIELD_READONLY"],
      [false, false, "RESOURCE_NOT_MANAGED"],
    ] as const) {
      const repository = await configuredRepository(writable, managed);
      const current = repository.sources.get(sourceId)!;
      const input: LocalProposal = {
        ...(await proposal(
          managed ? repository : await configuredRepository(true, true),
        )),
        configurationVersion: current.document.configuration.version,
        schemaVersion: current.document.schema!.version,
      };
      await expect(
        submitLocalPatch(input, agent, repository, repository),
      ).rejects.toMatchObject({ status: 409, code });
    }
  });

  it("rejects frozen proposals after schema or configuration changes", async () => {
    const repository = await configuredRepository();
    const staleConfiguration = await proposal(repository);
    await configureLocalSourceSchema(
      {
        expectedVersion: staleConfiguration.configurationVersion,
        resources: [
          {
            name: "public.articles",
            managed: true,
            fields: [
              { name: "id", writable: false },
              { name: "title", writable: false },
            ],
          },
        ],
      },
      human,
      repository,
      sourceId,
    );
    await expect(
      submitLocalPatch(staleConfiguration, agent, repository, repository),
    ).rejects.toMatchObject({
      status: 409,
      code: "STALE_SOURCE_CONFIGURATION",
    });

    const current = await proposal(repository);
    const changedResources = structuredClone(resources);
    changedResources[0]!.fields.push({
      name: "summary",
      type: "text",
      nullable: true,
      primaryKey: false,
      databaseReadonly: false,
    });
    await syncLocalSourceSchema(
      {
        name: "Editorial database",
        schemaVersion: schemaVersion(changedResources),
        resources: changedResources,
      },
      agent,
      repository,
      sourceId,
    );
    await expect(
      submitLocalPatch(current, agent, repository, repository),
    ).rejects.toMatchObject({ status: 409, code: "STALE_SOURCE_SCHEMA" });
  });

  it("uses the locked execution-start transition and rejects approved stale revisions", async () => {
    const repository = await configuredRepository();
    const submitted = await submitLocalPatch(
      await proposal(repository),
      agent,
      repository,
      repository,
    );
    const approved = await decideLocalPatch(
      { revision: submitted.revision, decision: "APPROVED" },
      human,
      repository,
      submitted.id,
    );
    await reportLocalExecution(
      { revision: approved.revision, status: "STARTED" },
      agent,
      repository,
      approved.id,
    );
    expect(repository.start).toHaveBeenCalledTimes(1);

    const secondRepository = await configuredRepository();
    const secondSubmitted = await submitLocalPatch(
      await proposal(secondRepository),
      agent,
      secondRepository,
      secondRepository,
    );
    const secondApproved = await decideLocalPatch(
      { revision: secondSubmitted.revision, decision: "APPROVED" },
      human,
      secondRepository,
      secondSubmitted.id,
    );
    if ("kind" in secondApproved.proposal)
      throw new Error("Unexpected localization patch.");
    await configureLocalSourceSchema(
      {
        expectedVersion: secondApproved.proposal.configurationVersion,
        resources: [
          {
            name: "public.articles",
            managed: true,
            fields: [
              { name: "id", writable: false },
              { name: "title", writable: false },
            ],
          },
        ],
      },
      human,
      secondRepository,
      sourceId,
    );
    await expect(
      reportLocalExecution(
        { revision: secondApproved.revision, status: "STARTED" },
        agent,
        secondRepository,
        secondApproved.id,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "STALE_SOURCE_CONFIGURATION",
    });
  });
});

describe("repository localization proposals", () => {
  it("binds proposals to a human-configured source and the normal exact-revision decision", async () => {
    const repository = new MemoryRepository();
    const configuration = {
      type: "repository-localization" as const,
      name: "App translations",
      repositoryUrl: "https://github.com/example/app.git",
      baseBranch: "main",
      baseLocale: "en",
      locales: ["en", "de"],
      paths: { en: "locales/en.json", de: "locales/de.json" },
    };
    const token = await createLocalClientToken(
      human,
      repository,
      configuration,
    );
    expect(token.connectionId).toBeTruthy();
    const scopedAgent: Actor = {
      ...agent,
      connectionIds: [token.connectionId],
    };
    const proposal = {
      kind: "repository-localization" as const,
      id: patchId,
      connectionId: token.connectionId,
      repositoryUrl: configuration.repositoryUrl,
      baseBranch: configuration.baseBranch,
      baseLocale: configuration.baseLocale,
      baseCommitSha: "a".repeat(40),
      title: "German checkout copy",
      createdAt: new Date().toISOString(),
      operations: [
        {
          id: operationId,
          key: "checkout.cancel",
          sourceLocale: "en",
          sourceText: "Cancel",
          sourceRevision: localizationSourceRevision(
            "en",
            "checkout.cancel",
            "Cancel",
          ),
          sourcePath: "locales/en.json",
          targetLocale: "de",
          targetBefore: null,
          targetAfter: "Abbrechen",
          targetPath: "locales/de.json",
          targetBlobSha: "b".repeat(40),
          translationStatus: "missing",
          recordedSourceRevision: null,
        },
      ],
    };
    const submitted = await submitLocalPatch(
      proposal,
      scopedAgent,
      repository,
      repository,
    );
    expect(submitted.status).toBe("SUBMITTED");
    await expect(
      decideLocalPatch(
        { revision: submitted.revision, decision: "APPROVED" },
        scopedAgent,
        repository,
        patchId,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      submitLocalPatch(
        {
          ...proposal,
          operations: [
            { ...proposal.operations[0], targetPath: "locales/other.json" },
          ],
        },
        scopedAgent,
        repository,
        repository,
      ),
    ).rejects.toMatchObject({ code: "LOCALE_NOT_CONFIGURED" });
    await expect(
      decideLocalPatch(
        { revision: "f".repeat(64), decision: "APPROVED" },
        human,
        repository,
        patchId,
      ),
    ).rejects.toMatchObject({ code: "STALE_REVISION" });
    const invalidStored = structuredClone(submitted);
    if ("kind" in invalidStored.proposal)
      invalidStored.proposal.operations[0].sourceRevision = "f".repeat(64);
    repository.patches.set(patchId, invalidStored);
    await expect(
      decideLocalPatch(
        { revision: submitted.revision, decision: "APPROVED" },
        human,
        repository,
        patchId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_LOCALIZATION" });
    repository.patches.set(patchId, submitted);
    const approved = await decideLocalPatch(
      { revision: submitted.revision, decision: "APPROVED" },
      human,
      repository,
      patchId,
    );
    expect(approved.status).toBe("APPROVED");
    expect(approved.reviewerId).toBe(human.id);
    await expect(
      reportLocalExecution(
        { revision: submitted.revision, status: "STARTED" },
        scopedAgent,
        repository,
        patchId,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await reportLocalExecution(
      { revision: submitted.revision, status: "STARTED" },
      human,
      repository,
      patchId,
    );
    const receipt = {
      branch: `patchctl/l10n/${patchId}`,
      commitSha: "c".repeat(40),
      prUrl: "https://github.com/example/app/pull/1",
    };
    await expect(
      reportLocalExecution(
        { revision: submitted.revision, status: "APPLIED" },
        human,
        repository,
        patchId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RECEIPT" });
    await expect(
      reportLocalExecution(
        {
          revision: submitted.revision,
          status: "APPLIED",
          receipt: { ...receipt, prUrl: "https://github.com/other/app/pull/1" },
        },
        human,
        repository,
        patchId,
      ),
    ).rejects.toMatchObject({ code: "INVALID_RECEIPT" });
    const applied = await reportLocalExecution(
      { revision: submitted.revision, status: "APPLIED", receipt },
      human,
      repository,
      patchId,
    );
    expect(applied.receipt).toEqual(receipt);
    expect(applied.events.at(-1)?.event).toBe("PATCH_APPLIED");
    const replay = await reportLocalExecution(
      { revision: submitted.revision, status: "APPLIED", receipt },
      human,
      repository,
      patchId,
    );
    expect(replay.events).toHaveLength(applied.events.length);
    await expect(
      reportLocalExecution(
        {
          revision: submitted.revision,
          status: "APPLIED",
          receipt: { ...receipt, commitSha: "d".repeat(40) },
        },
        human,
        repository,
        patchId,
      ),
    ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  });
});
