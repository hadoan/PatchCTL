import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import {
  NativeCredentialStore,
  databaseCredential,
  type CredentialStore,
} from "./credentials.js";
import {
  configDirectory,
  credentialReference,
  legacyCredentialReference,
  readConfig,
  sourceMetadata,
  tenantIdSchema,
  writeConfig,
} from "./config.js";
import { LocalError } from "./errors.js";
import { syncAndResolveResources } from "./source-sync.js";
import {
  discoverResources,
  privilegeWarnings,
  readRecords,
  requireResource,
  selectedResources,
  withDatabase,
} from "@patchctl/postgres";

export const localCommands = [
  "connect",
  "init",
  "sources",
  "resources",
  "schema",
  "list",
  "get",
  "agent-guide",
];
export async function hiddenSecret(
  label = "PostgreSQL connection string",
): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new LocalError(
      "CREDENTIAL_NOT_FOUND",
      "Interactive connection needs a terminal. For headless use, explicitly set PATCHCTL_DATABASE_URL.",
    );
  process.stderr.write(`${label} (hidden): `);
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let secret = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003" || character === "\u0004") {
          cleanup();
          reject(new LocalError("CANCELLED", "Connection cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(secret);
          return;
        }
        if (character === "\u007f" || character === "\b")
          secret = secret.slice(0, -1);
        else if (character >= " ") secret += character;
        if (secret.length > 16384) {
          cleanup();
          reject(
            new LocalError("INVALID_VALUE", "Connection string is too long."),
          );
          return;
        }
      }
    };
    input.on("data", onData);
  });
}

function parseLocal(args: string[]) {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--json") {
      flags.add(arg);
      continue;
    }
    if (
      !["--tenant", "--resources", "--columns", "--limit"].includes(arg) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--") ||
      options[arg] !== undefined
    )
      throw new LocalError(
        "INVALID_INPUT",
        "Unknown option, duplicate option, or missing value.",
      );
    options[arg] = args[++index];
  }
  const command = positionals[0];
  const validPositionals =
    command === "get"
      ? positionals.length === 3
      : command === "list"
        ? positionals.length === 2
        : command === "schema"
          ? positionals.length >= 1 && positionals.length <= 3
          : command === "connect"
            ? positionals.length === 1 ||
              (positionals.length === 2 && positionals[1] === "postgres")
            : positionals.length === 1;
  if (!validPositionals)
    throw new LocalError("INVALID_INPUT", "Invalid command arguments.");
  for (const option of Object.keys(options)) {
    if (
      (option === "--limit" && command !== "list") ||
      (["--resources", "--columns"].includes(option) && command !== "init")
    )
      throw new LocalError(
        "INVALID_INPUT",
        "Option is not supported by this command.",
      );
  }
  return { positionals, options, flags };
}

export async function runLocal(
  args: string[],
  {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    credentials = new NativeCredentialStore(),
    promptSecret = hiddenSecret,
    fetchImpl,
  }: {
    env?: NodeJS.ProcessEnv;
    stdout?: { write(value: string): unknown };
    stderr?: { write(value: string): unknown };
    credentials?: CredentialStore;
    promptSecret?: () => Promise<string>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<number> {
  try {
    const {
      positionals: [command, firstArgument, secondArgument],
      options,
    } = parseLocal(args);
    if (command === "agent-guide") {
      stdout.write(
        JSON.stringify({
          principle:
            "Credentials stay local. Agents propose. Humans approve. Local clients execute.",
          available: [
            "connect postgres --tenant NAME",
            "sources --json",
            "init --resources public.articles --columns id,title",
            "schema NAME --json",
            "resources --json",
            "list articles --json",
            "get articles ID --json",
            "patch start",
            "update articles ID --set title=VALUE",
            "diff --json",
            "validate --json",
          ],
          status:
            "Local drafts, validation, normalized schema metadata sync, web-managed resource configuration, and non-secret proposal submission are available. Local content apply is not implemented yet. Hosted server-owned-DSN commands require the explicit server namespace.",
        }) + "\n",
      );
      return 0;
    }
    const directory = configDirectory(env);
    const config = await readConfig(directory);
    if (command === "sources") {
      const postgresSources = Object.entries(config.tenants).map(
        ([tenantId, local]) => {
          const source = sourceMetadata(tenantId, local);
          return { id: source.id, name: source.name, type: source.type };
        },
      );
      const repositorySources = Object.values(
        config.repositoryLocalization ?? {},
      ).flatMap((items) =>
        items.map(({ id, name, type }) => ({ id, name, type })),
      );
      const sources = [...postgresSources, ...repositorySources].sort(
        (left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
      stdout.write(JSON.stringify({ sources }) + "\n");
      return 0;
    }
    let requestedTenant =
      options["--tenant"] ?? config.currentTenant ?? "default";
    let resourceName = firstArgument;
    const id = secondArgument;
    if (command === "schema" && firstArgument) {
      const sourceEntry = Object.entries(config.tenants).find(
        ([tenantId, local]) => {
          const source = sourceMetadata(tenantId, local);
          return (
            tenantId === firstArgument ||
            source.id === firstArgument ||
            source.name === firstArgument
          );
        },
      );
      if (!sourceEntry)
        throw new LocalError(
          "SOURCE_NOT_FOUND",
          "The requested local source is not configured.",
        );
      requestedTenant = sourceEntry[0];
      resourceName = secondArgument;
    }
    const tenant = tenantIdSchema.safeParse(requestedTenant);
    if (!tenant.success)
      throw new LocalError(
        "INVALID_INPUT",
        "Tenant name must contain 1–64 letters, digits, underscores, or hyphens.",
      );
    const tenantId = tenant.data;
    if (command === "connect") {
      const fromEnvironment = Boolean(env.PATCHCTL_DATABASE_URL);
      const secret = env.PATCHCTL_DATABASE_URL ?? (await promptSecret());
      const inspection = await withDatabase(secret, async (client) => ({
        warnings: await privilegeWarnings(client),
        discovered: await discoverResources(client),
      }));
      const warnings = inspection.warnings;
      const existing = config.tenants[tenantId];
      const sourceId = existing
        ? sourceMetadata(tenantId, existing).id
        : randomUUID();
      const source = {
        id: sourceId,
        name: tenantId,
        type: "postgres" as const,
        credentialRef: `patchctl/source/${sourceId}`,
      };
      if (fromEnvironment)
        warnings.push(
          "Using PATCHCTL_DATABASE_URL only for this process; no credential was persisted. Prefer the OS keyring.",
        );
      const nextLocal = {
        source,
        resources: [],
        databaseId: randomUUID(),
        ...(existing?.server ? { server: existing.server } : {}),
      };
      let synchronization: Awaited<
        ReturnType<typeof syncAndResolveResources>
      > | null = null;
      if (nextLocal.server) {
        const token =
          env.PATCHCTL_TOKEN ??
          (await credentials.get(`${tenantId}/server-token`));
        if (token)
          synchronization = await syncAndResolveResources(
            tenantId,
            nextLocal,
            inspection.discovered,
            credentials,
            env,
            fetchImpl,
          );
        else
          throw new LocalError(
            "CREDENTIAL_NOT_FOUND",
            "The paired server token is unavailable. Run patchctl login again before reconnecting this source.",
          );
      }
      const previousCredential = fromEnvironment
        ? null
        : await credentials.get(source.credentialRef);
      if (!fromEnvironment) await credentials.set(source.credentialRef, secret);
      config.currentTenant = tenantId;
      // Reconnecting may target a different database. Server-managed configuration
      // is applied only after the fresh normalized schema is synchronized.
      config.tenants[tenantId] = nextLocal;
      try {
        await writeConfig(directory, config);
      } catch (error) {
        if (!fromEnvironment) {
          try {
            if (previousCredential)
              await credentials.set(source.credentialRef, previousCredential);
            else await credentials.delete(source.credentialRef);
          } catch {
            throw new LocalError(
              "CREDENTIAL_ROLLBACK_FAILED",
              "Local configuration was not changed, but the previous OS credential could not be restored. Reconnect before using this source.",
            );
          }
        }
        throw error;
      }
      stdout.write(
        JSON.stringify({
          ok: true,
          source: { id: source.id, name: source.name, type: source.type },
          discoveredResources: inspection.discovered.length,
          schemaSynced: synchronization !== null,
          schemaVersion: synchronization?.schemaVersion ?? null,
          configurationUrl: synchronization?.configurationUrl ?? null,
          credentialStorage: fromEnvironment ? "environment" : "os-keyring",
          warnings,
        }) + "\n",
      );
      return 0;
    }
    if (!Object.hasOwn(config.tenants, tenantId))
      throw new LocalError(
        "CREDENTIAL_NOT_FOUND",
        "Run patchctl connect first.",
      );
    const local = config.tenants[tenantId];
    const { secret, warnings } = await databaseCredential(
      credentialReference(tenantId, local),
      credentials,
      env,
      legacyCredentialReference(local),
    );
    const result = await withDatabase(secret, async (client) => {
      const discovered = await discoverResources(client);
      if (command === "init") {
        let names = options["--resources"];
        let columns = options["--columns"];
        if (!names || !columns) {
          if (!process.stdin.isTTY || args.includes("--json"))
            throw new LocalError(
              "RESOURCE_SELECTION_REQUIRED",
              "Explicitly select --resources schema.table,... and --columns column,... (or * for all columns of selected tables).",
            );
          const prompt = createInterface({
            input: process.stdin,
            output: process.stderr,
          });
          try {
            stderr.write(
              `${discovered.length} tables found:\n${discovered.map((r) => r.name).join("\n")}\n`,
            );
            names ??= await prompt.question(
              "Select tables (comma-separated, no defaults): ",
            );
            const tables = names
              .split(",")
              .map((name) => requireResource(discovered, name.trim()));
            stderr.write(
              tables
                .map(
                  (table) =>
                    `${table.name}: ${table.fields.map((f) => `${f.name}${f.readonly ? " (readonly)" : ""}`).join(", ")}`,
                )
                .join("\n") + "\n",
            );
            columns ??= await prompt.question(
              "Select columns (comma-separated, or * for all displayed columns): ",
            );
          } finally {
            prompt.close();
          }
        }
        const selected = [
          ...new Set(names.split(",").map((name) => name.trim())),
        ].map((name) => requireResource(discovered, name));
        const requested = [
          ...new Set(columns.split(",").map((name) => name.trim())),
        ];
        if (
          requested.some(
            (name) =>
              name !== "*" &&
              !selected.some((r) => r.fields.some((f) => f.name === name)),
          ) ||
          (requested.includes("*") && requested.length !== 1)
        )
          throw new LocalError(
            "FIELD_NOT_FOUND",
            "A selected column does not exist in the selected tables.",
          );
        const selections = selected.map((r) => {
          const selectedColumns = r.fields
            .filter(
              (f) => requested.includes("*") || requested.includes(f.name),
            )
            .map((f) => f.name);
          if (
            !r.primaryKey ||
            !selectedColumns.includes(r.primaryKey) ||
            r.fields.find((f) => f.name === r.primaryKey)?.type ===
              "unsupported"
          )
            throw new LocalError(
              "UNSUPPORTED_PRIMARY_KEY",
              "Each selected resource must include a supported single-column primary key.",
            );
          return {
            schemaName: r.schemaName,
            tableName: r.tableName,
            columns: selectedColumns,
          };
        });
        local.resources = selections;
        config.currentTenant = tenantId;
        await writeConfig(directory, config);
        return { resources: selectedResources(discovered, selections) };
      }
      const effective = await syncAndResolveResources(
        tenantId,
        local,
        discovered,
        credentials,
        env,
        fetchImpl,
      );
      const resources = effective.resources;
      if (command === "resources")
        return {
          resources: resources.map((r) => ({ name: r.name })),
          schemaVersion: effective.schemaVersion,
          configurationVersion: effective.configurationVersion,
          schemaSynced: effective.synced,
        };
      if (command === "schema" && !resourceName) {
        const source = sourceMetadata(tenantId, local);
        return {
          source: {
            id: source.id,
            name: source.name,
            type: source.type,
            ...(local.server
              ? { serverSourceId: local.server.connectionId }
              : {}),
          },
          schemaVersion: effective.schemaVersion,
          configurationVersion: effective.configurationVersion,
          configurationUrl: effective.configurationUrl,
          schemaSynced: effective.synced,
          resources,
        };
      }
      const resource = requireResource(resources, resourceName);
      if (command === "schema")
        return {
          resource,
          schemaVersion: effective.schemaVersion,
          configurationVersion: effective.configurationVersion,
          configurationUrl: effective.configurationUrl,
          schemaSynced: effective.synced,
        };
      if (command === "get" || command === "list") {
        const records = await readRecords(
          client,
          resource,
          command === "get" ? id : undefined,
          Number(options["--limit"] ?? "20"),
        );
        if (command === "get" && records.length === 0)
          throw new LocalError(
            "RECORD_NOT_FOUND",
            "Record was not found in the selected resource.",
          );
        return command === "get"
          ? { resource: resource.name, record: records[0] }
          : { resource: resource.name, records };
      }
      throw new LocalError("INVALID_INPUT", "Unknown local command.");
    });
    stdout.write(JSON.stringify({ ...result, warnings }) + "\n");
    return 0;
  } catch (error) {
    const known = error instanceof LocalError;
    stderr.write(
      JSON.stringify({
        ok: false,
        error: {
          code: known ? error.code : "LOCAL_IO_ERROR",
          message: known
            ? error.message
            : "Could not access local configuration.",
        },
      }) + "\n",
    );
    return 1;
  }
}
