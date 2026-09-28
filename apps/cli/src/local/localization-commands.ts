import { randomUUID } from "node:crypto";
import {
  createPatchctlClient,
  PatchctlClientError,
} from "@corely/api-client/patchctl";
import { RepositoryLocalizationProposalSchema } from "@corely/contracts";
import { validateLocalizationProposal } from "@patchctl/localization";
import {
  configDirectory,
  readConfig,
  writeConfig,
  tenantIdSchema,
} from "./config.js";
import { NativeCredentialStore, type CredentialStore } from "./credentials.js";
import { hiddenSecret } from "./commands.js";
import { LocalError } from "./errors.js";
import {
  modelLocalizationEntries,
  type LocalizationEntry,
} from "./localization-entries.js";
import {
  discoverRepositoryLocalization,
  type RepositoryLocalizationSource,
} from "./repository-localization.js";
import {
  readLocalizationDraft,
  startLocalizationDraft,
  withLocalizationDraftLock,
  type LocalizationDraft,
} from "./localization-drafts.js";

type Output = { write(value: string): unknown };
type Options = Record<string, string>;

function parse(args: string[]) {
  const positionals: string[] = [];
  const options: Options = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") continue;
    if (arg.startsWith("--")) {
      if (
        ![
          "--tenant",
          "--source",
          "--locale",
          "--value",
          "--title",
          "--server",
          "--after",
          "--limit",
        ].includes(arg) ||
        options[arg] !== undefined ||
        args[i + 1] === undefined
      )
        throw new LocalError(
          "INVALID_INPUT",
          "Unknown option, duplicate option, or missing value.",
        );
      options[arg] = args[++i];
    } else positionals.push(arg);
  }
  const [command] = positionals;
  if (
    !command ||
    ![
      "locales",
      "missing",
      "stale",
      "get",
      "start",
      "set",
      "diff",
      "validate",
      "login",
      "submit",
    ].includes(command) ||
    positionals.length !== (["get", "set"].includes(command) ? 2 : 1)
  )
    throw new LocalError(
      "INVALID_INPUT",
      "Invalid localization command arguments.",
    );
  const allowed: Record<string, string[]> = {
    locales: [],
    missing: ["--locale", "--after", "--limit"],
    stale: ["--locale", "--after", "--limit"],
    get: ["--locale"],
    start: ["--title"],
    set: ["--locale", "--value"],
    diff: [],
    validate: [],
    login: ["--server"],
    submit: [],
  };
  for (const option of Object.keys(options))
    if (!["--tenant", "--source", ...allowed[command]].includes(option))
      throw new LocalError(
        "INVALID_INPUT",
        "Option is not supported by this command.",
      );
  if (["get", "set"].includes(command) && !options["--locale"])
    throw new LocalError("INVALID_INPUT", "Specify --locale for this command.");
  if (command === "set" && options["--value"] === undefined)
    throw new LocalError(
      "INVALID_INPUT",
      "Specify --value for the proposed translation.",
    );
  if (command === "login" && !options["--server"])
    throw new LocalError(
      "INVALID_INPUT",
      "Specify --server for localization login.",
    );
  return { command, key: positionals[1], options };
}

function selectSource(
  config: Awaited<ReturnType<typeof readConfig>>,
  options: Options,
) {
  const tenantId = options["--tenant"] ?? config.currentTenant;
  if (!tenantId || !tenantIdSchema.safeParse(tenantId).success)
    throw new LocalError(
      "TENANT_NOT_CONFIGURED",
      "Select a configured Tenant with --tenant.",
    );
  const configured = config.repositoryLocalization?.[tenantId] ?? [];
  const selected = options["--source"]
    ? configured.find(
        (source) =>
          source.id === options["--source"] ||
          source.name === options["--source"],
      )
    : configured.length === 1
      ? configured[0]
      : undefined;
  if (!selected)
    throw new LocalError(
      "SOURCE_NOT_FOUND",
      "Select one configured repository localization source with --source.",
    );
  return { tenantId, source: selected };
}

async function entries(source: RepositoryLocalizationSource) {
  const snapshot = await discoverRepositoryLocalization(source);
  return {
    snapshot,
    entries: modelLocalizationEntries(snapshot, source.baselines ?? []),
  };
}

function requireEntry(all: LocalizationEntry[], key: string, locale: string) {
  const entry = all.find(
    (item) => item.key === key && item.targetLocale === locale,
  );
  if (!entry)
    throw new LocalError(
      "TRANSLATION_NOT_FOUND",
      "Translation key or target locale is not configured.",
    );
  return entry;
}

function validateDraft(
  draft: LocalizationDraft,
  source: RepositoryLocalizationSource,
  snapshot: Awaited<ReturnType<typeof discoverRepositoryLocalization>>,
  all: LocalizationEntry[],
) {
  const errors: {
    code: string;
    message: string;
    key?: string;
    locale?: string;
  }[] = [];
  if (
    draft.sourceId !== source.id ||
    draft.repositoryUrl !== source.repositoryUrl ||
    draft.baseBranch !== source.baseBranch ||
    draft.baseLocale !== source.baseLocale ||
    draft.baseCommitSha !== snapshot.commitSha
  )
    errors.push({
      code: "SOURCE_CHANGED",
      message:
        "Repository source or base revision changed; create a new Patch.",
    });
  if (!draft.operations.length)
    errors.push({
      code: "EMPTY_PATCH",
      message: "Add at least one translation.",
    });
  for (const operation of draft.operations) {
    const entry = all.find(
      (item) =>
        item.key === operation.key &&
        item.targetLocale === operation.targetLocale,
    );
    if (
      !entry ||
      entry.sourceRevision !== operation.sourceRevision ||
      entry.sourcePath !== operation.sourcePath ||
      entry.targetPath !== operation.targetPath ||
      entry.targetBlobSha !== operation.targetBlobSha ||
      entry.targetText !== operation.targetBefore
    ) {
      errors.push({
        code: "PATCH_CONFLICT",
        message:
          "Source or target text changed after this proposal was prepared.",
        key: operation.key,
        locale: operation.targetLocale,
      });
      continue;
    }
    errors.push(
      ...validateLocalizationProposal(
        entry,
        operation.targetAfter,
        operation.sourceRevision,
      ).errors,
    );
  }
  return errors;
}

export async function runLocalizationCommand(
  args: string[],
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    credentials = new NativeCredentialStore(),
    promptToken = () => hiddenSecret("PatchCTL client token"),
    fetchImpl,
  }: {
    env?: NodeJS.ProcessEnv;
    stdout?: Output;
    stderr?: Output;
    credentials?: CredentialStore;
    promptToken?: () => Promise<string>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<number> {
  try {
    const { command, key, options } = parse(args);
    const directory = configDirectory(env);
    const config = await readConfig(directory);
    const { tenantId, source } = selectSource(config, options);
    if (command === "login") {
      const token = env.PATCHCTL_TOKEN ?? (await promptToken());
      const client = createPatchctlClient({
        baseUrl: options["--server"],
        getAccessToken: () => token,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
      const actor = await client.actor();
      if (
        actor.kind !== "agent" ||
        actor.connectionIds?.length !== 1 ||
        !actor.permissions.includes("propose")
      )
        throw new LocalError(
          "INVALID_TOKEN",
          "Use a scoped repository localization client token created by a human.",
        );
      source.server = {
        url: new URL(options["--server"]).origin,
        tenantId: actor.tenantId,
        connectionId: actor.connectionIds[0],
      };
      config.currentTenant = tenantId;
      await writeConfig(directory, config);
      if (!env.PATCHCTL_TOKEN)
        await credentials.set(`${tenantId}/server-token`, token);
      stdout.write(
        JSON.stringify({
          ok: true,
          tenantId: actor.tenantId,
          connectionId: source.server.connectionId,
          sourceId: source.id,
        }) + "\n",
      );
      return 0;
    }
    if (command === "locales") {
      stdout.write(
        JSON.stringify({
          sourceId: source.id,
          baseLocale: source.baseLocale,
          locales: [...source.locales].sort(),
        }) + "\n",
      );
      return 0;
    }
    if (["missing", "stale", "get"].includes(command)) {
      const current = await entries(source);
      if (command === "get") {
        stdout.write(
          JSON.stringify({
            entry: requireEntry(current.entries, key!, options["--locale"]),
            commitSha: current.snapshot.commitSha,
          }) + "\n",
        );
        return 0;
      }
      const limit =
        options["--limit"] === undefined ? 100 : Number(options["--limit"]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new LocalError(
          "INVALID_INPUT",
          "Limit must be an integer from 1 to 100.",
        );
      const filtered = current.entries.filter(
        (item) =>
          item.status === command &&
          (!options["--locale"] || item.targetLocale === options["--locale"]),
      );
      const after = options["--after"];
      const remaining = filtered.filter(
        (item) =>
          !after || JSON.stringify([item.targetLocale, item.key]) > after,
      );
      const page = remaining.slice(0, limit);
      stdout.write(
        JSON.stringify({
          sourceId: source.id,
          commitSha: current.snapshot.commitSha,
          entries: page,
          nextCursor:
            remaining.length > page.length
              ? JSON.stringify([page.at(-1)?.targetLocale, page.at(-1)?.key])
              : null,
        }) + "\n",
      );
      return 0;
    }
    if (command === "start") {
      const { snapshot } = await entries(source);
      const draft = await withLocalizationDraftLock(
        directory,
        tenantId,
        async (save) => {
          try {
            const existing = await readLocalizationDraft(directory, tenantId);
            if (existing.status === "DRAFT")
              throw new LocalError(
                "PATCH_ALREADY_ACTIVE",
                "An active localization draft already exists.",
              );
          } catch (caught) {
            if (
              !(
                caught instanceof LocalError &&
                caught.code === "NO_ACTIVE_PATCH"
              )
            )
              throw caught;
          }
          const created = startLocalizationDraft({
            tenantId,
            sourceId: source.id,
            repositoryUrl: source.repositoryUrl,
            baseBranch: source.baseBranch,
            baseLocale: source.baseLocale,
            baseCommitSha: snapshot.commitSha,
            title: options["--title"] ?? "Localization update",
          });
          await save(created);
          return created;
        },
      );
      stdout.write(JSON.stringify({ patch: draft }) + "\n");
      return 0;
    }
    let valid = true;
    const result = await withLocalizationDraftLock(
      directory,
      tenantId,
      async (save) => {
        const draft = await readLocalizationDraft(directory, tenantId);
        if (draft.sourceId !== source.id)
          throw new LocalError(
            "SOURCE_CHANGED",
            "Draft belongs to another repository localization source.",
          );
        if (command === "diff")
          return { patchId: draft.id, operations: draft.operations };
        const current =
          command === "submit" && draft.status !== "DRAFT"
            ? null
            : await entries(source);
        if (command === "set") {
          if (!current)
            throw new LocalError("INVALID_INPUT", "Source unavailable.");
          if (draft.status !== "DRAFT")
            throw new LocalError(
              "PATCH_ALREADY_SUBMITTED",
              "Submitted patches are immutable. Start a new Patch.",
            );
          if (draft.baseCommitSha !== current.snapshot.commitSha)
            throw new LocalError(
              "SOURCE_CHANGED",
              "Base revision changed; create a new Patch.",
            );
          const entry = requireEntry(
            current.entries,
            key!,
            options["--locale"],
          );
          const validation = validateLocalizationProposal(
            entry,
            options["--value"],
          );
          if (!validation.valid) {
            valid = false;
            return { valid: false, errors: validation.errors };
          }
          if (entry.targetText === options["--value"])
            throw new LocalError(
              "NO_CHANGE",
              "Proposed translation matches the current value.",
            );
          const existing = draft.operations.find(
            (op) => op.key === key && op.targetLocale === entry.targetLocale,
          );
          if (
            existing &&
            (existing.sourceRevision !== entry.sourceRevision ||
              existing.targetBefore !== entry.targetText ||
              existing.targetBlobSha !== entry.targetBlobSha)
          )
            throw new LocalError(
              "PATCH_CONFLICT",
              "Translation changed after this draft was prepared.",
            );
          const operation = {
            id: existing?.id ?? randomUUID(),
            key: entry.key,
            sourceLocale: entry.sourceLocale,
            sourceText: entry.sourceText,
            sourceRevision: entry.sourceRevision,
            sourcePath: entry.sourcePath,
            targetLocale: entry.targetLocale,
            targetBefore: entry.targetText,
            targetAfter: options["--value"],
            targetPath: entry.targetPath,
            targetBlobSha: entry.targetBlobSha,
          };
          if (existing)
            draft.operations[draft.operations.indexOf(existing)] = operation;
          else {
            if (draft.operations.length >= 100)
              throw new LocalError(
                "PATCH_TOO_LARGE",
                "A localization Patch can change at most 100 entries.",
              );
            draft.operations.push(operation);
          }
          await save(draft);
          return { valid: true, patchId: draft.id, operation };
        }
        const errors =
          command === "submit" && draft.status !== "DRAFT"
            ? []
            : validateDraft(draft, source, current!.snapshot, current!.entries);
        if (command === "validate") {
          valid = errors.length === 0;
          return { valid, errors };
        }
        if (command !== "submit")
          throw new LocalError(
            "INVALID_INPUT",
            "Unknown localization command.",
          );
        if (errors.length) {
          valid = false;
          return { valid: false, errors };
        }
        if (!source.server)
          throw new LocalError(
            "SERVER_NOT_CONFIGURED",
            "Run patchctl localization login --server ORIGIN first.",
          );
        if (
          draft.submittedServer &&
          JSON.stringify(draft.submittedServer) !==
            JSON.stringify(source.server)
        )
          throw new LocalError(
            "SERVER_CHANGED",
            "This Patch was submitted to a different server connection.",
          );
        const token =
          env.PATCHCTL_TOKEN ??
          (await credentials.get(`${tenantId}/server-token`));
        if (!token)
          throw new LocalError(
            "CREDENTIAL_NOT_FOUND",
            "Local server token is unavailable.",
          );
        const client = createPatchctlClient({
          baseUrl: source.server.url,
          getAccessToken: () => token,
          ...(fetchImpl ? { fetch: fetchImpl } : {}),
        });
        const actor = await client.actor();
        if (
          actor.tenantId !== source.server.tenantId ||
          !actor.connectionIds?.includes(source.server.connectionId) ||
          actor.kind !== "agent"
        )
          throw new LocalError(
            "TENANT_MISMATCH",
            "Token does not match this Tenant and repository source.",
          );
        const proposal = RepositoryLocalizationProposalSchema.parse({
          kind: "repository-localization",
          id: draft.id,
          connectionId: source.server.connectionId,
          repositoryUrl: draft.repositoryUrl,
          baseBranch: draft.baseBranch,
          baseLocale: draft.baseLocale,
          baseCommitSha: draft.baseCommitSha,
          title: draft.title,
          createdAt: draft.createdAt,
          operations: draft.operations,
        });
        const serialized = JSON.stringify(proposal);
        if (
          serialized.includes(token) ||
          Buffer.byteLength(serialized) > 2_000_000
        )
          throw new LocalError(
            "PATCH_TOO_LARGE",
            "Patch is too large or contains a credential.",
          );
        if (draft.status === "DRAFT") {
          draft.status = "SUBMITTED";
          draft.submittedServer = source.server;
          await save(draft);
        }
        const submitted = await client.localSubmit(proposal);
        draft.status = submitted.status;
        await save(draft);
        return {
          patchId: submitted.id,
          status: submitted.status,
          revision: submitted.revision,
          reviewUrl: `${source.server.url}/patches/${submitted.id}`,
        };
      },
    );
    stdout.write(JSON.stringify(result) + "\n");
    return valid ? 0 : 1;
  } catch (caught) {
    const known =
      caught instanceof LocalError || caught instanceof PatchctlClientError;
    stderr.write(
      JSON.stringify({
        ok: false,
        error: {
          code: known ? caught.code : "LOCALIZATION_ERROR",
          message: known
            ? caught.message
            : "Could not access repository localization state.",
        },
      }) + "\n",
    );
    return 1;
  }
}
