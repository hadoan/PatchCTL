import {
  PatchActorSchema,
  PatchSourcesSchema,
  PatchContentSchemaResponseSchema,
  PatchContentPageSchema,
  PatchRelationPageSchema,
  PatchResponseSchema,
  PatchListSchema,
  PatchPreparedSchema,
  PatchHistorySchema,
  PatchAppliedSchema,
  PatchProposalInputSchema,
  ContentQueryInputSchema,
  PatchDecisionInputSchema,
  PatchApplyInputSchema,
  type PatchProposalInput,
  type PatchContentQueryInput,
  type PatchDecisionInput,
  type PatchApplyInput,
  LocalPatchSchema,
  LocalPatchListSchema,
  LocalPatchProposalSchema,
  LocalDecisionSchema,
  LocalResultSchema,
  LocalClientTokenSchema,
  RepositoryLocalizationSourceInputSchema,
  SourceSchemaStateSchema,
  SourceSchemaSyncInputSchema,
  SourceSchemaSyncResultSchema,
  SourceConfigurationInputSchema,
  SourceEffectiveSchemaSchema,
  type LocalPatchProposal,
  type RepositoryLocalizationSourceInput,
  type LocalExecutionResult,
  type SourceSchemaSyncInput,
  type SourceConfigurationInput,
} from "@corely/contracts";
import { request, HttpError } from "./http/request.js";

export class PatchctlClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "PatchctlClientError";
  }
}

export type PatchctlClientConfig = {
  /** Empty string uses browser-relative URLs; otherwise provide an HTTPS origin. */
  baseUrl: string;
  getAccessToken: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
  fetch?: typeof fetch;
  timeoutMs?: number;
};
type CallOptions = { signal?: AbortSignal };
type Schema<T> = { parse(input: unknown): T };

function parseInput<T>(schema: Schema<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch {
    throw new PatchctlClientError(
      "INVALID_INPUT",
      "Invalid PatchCTL request input.",
    );
  }
}
function segment(value: string): string {
  if (!value || value === "." || value === "..")
    throw new PatchctlClientError(
      "INVALID_INPUT",
      "Invalid resource identifier.",
    );
  return encodeURIComponent(value);
}
function query(input: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const credentialShapedDetail =
  /(?:postgres(?:ql)?:\/\/|\b(?:password|passwd|pwd|secret|token|authorization|bearer)\b)/i;
function safeApiErrorMessage(details: unknown, status: number): string {
  const fallback = `API returned HTTP ${status}.`;
  if (!isRecord(details) || typeof details.detail !== "string") return fallback;
  return credentialShapedDetail.test(details.detail)
    ? fallback
    : details.detail;
}

/** Portable, stateless client. Permissions and human approval are enforced by the server. */
export function createPatchctlClient(config: PatchctlClientConfig) {
  let origin = "";
  if (config.baseUrl !== "") {
    let base: URL;
    try {
      base = new URL(config.baseUrl);
    } catch {
      throw new PatchctlClientError(
        "INVALID_INPUT",
        "Invalid PatchCTL service origin.",
      );
    }
    if (
      (base.protocol !== "https:" &&
        !(
          base.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
        )) ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash
    )
      throw new PatchctlClientError(
        "INVALID_INPUT",
        "PatchCTL requires an HTTPS origin (HTTP is allowed on loopback).",
      );
    origin = base.origin;
  }
  const timeoutMs = config.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new PatchctlClientError(
      "INVALID_INPUT",
      "Timeout must be a positive integer.",
    );
  // Capture dependencies, never a token: callers may rotate credentials between requests.
  const getAccessToken = config.getAccessToken;
  const fetchImpl = config.fetch ?? fetch;

  async function call<T>(
    path: string,
    schema: Schema<T>,
    method = "GET",
    body?: unknown,
    options?: CallOptions,
  ): Promise<T> {
    let token: string | null | undefined;
    try {
      token = await getAccessToken();
    } catch {
      throw new PatchctlClientError(
        "AUTH_CONFIGURATION",
        "Could not obtain PatchCTL credentials.",
      );
    }
    if (!token)
      throw new PatchctlClientError(
        "UNAUTHENTICATED",
        "A PatchCTL access token is required.",
        401,
      );
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await request<Response>({
        url: `${origin}/api/patchctl${path}`,
        method,
        body,
        accessToken: token,
        headers: { "Content-Type": "application/json" },
        fetch: fetchImpl,
        redirect: "error",
        credentials: "omit",
        retry: { maxAttempts: 1 },
        parseJson: false,
        signal: options?.signal
          ? AbortSignal.any([timeout, options.signal])
          : timeout,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status !== null) {
        const details = error.body;
        throw new PatchctlClientError(
          isRecord(details) && typeof details.code === "string"
            ? details.code
            : "API_ERROR",
          safeApiErrorMessage(details, error.status),
          error.status,
        );
      }
      // Never expose transport exceptions, which may contain credentials or connection details.
      throw new PatchctlClientError(
        "NETWORK_ERROR",
        "API request failed or timed out. No automatic retry was attempted.",
      );
    }
    try {
      const result: unknown = await response.json();
      return schema.parse(result);
    } catch {
      throw new PatchctlClientError(
        "INVALID_RESPONSE",
        "API returned invalid JSON or an unexpected response shape.",
      );
    }
  }

  return {
    localSubmit: (input: LocalPatchProposal) =>
      call(
        "/local-patches",
        LocalPatchSchema,
        "POST",
        parseInput(LocalPatchProposalSchema, input),
      ),
    localPatch: (id: string) =>
      call(`/local-patches/${segment(id)}`, LocalPatchSchema, "GET"),
    localPatches: (after?: string, approved = false) =>
      call(
        `/local-patches${query({ after, ...(approved ? { approved: "true" } : {}) })}`,
        LocalPatchListSchema,
        "GET",
      ),
    localDecide: (
      id: string,
      revision: string,
      decision: "APPROVED" | "REJECTED",
    ) =>
      call(
        `/local-patches/${segment(id)}/decision`,
        LocalPatchSchema,
        "POST",
        parseInput(LocalDecisionSchema, { revision, decision }),
      ),
    localResult: (id: string, result: LocalExecutionResult) =>
      call(
        `/local-patches/${segment(id)}/execution-result`,
        LocalPatchSchema,
        "POST",
        parseInput(LocalResultSchema, result),
      ),
    createLocalToken: (input?: RepositoryLocalizationSourceInput) =>
      call(
        "/local-client-token",
        LocalClientTokenSchema,
        "POST",
        input ? parseInput(RepositoryLocalizationSourceInputSchema, input) : {},
      ),
    actor: (options?: CallOptions) =>
      call("/me", PatchActorSchema, "GET", undefined, options),
    sources: (options?: CallOptions) =>
      call("/sources", PatchSourcesSchema, "GET", undefined, options),
    localSources: (options?: CallOptions) =>
      call(
        "/sources?local=true",
        PatchSourcesSchema,
        "GET",
        undefined,
        options,
      ),
    sourceMetadata: (sourceId: string, options?: CallOptions) =>
      call(
        `/sources/${segment(sourceId)}/metadata`,
        SourceSchemaStateSchema,
        "GET",
        undefined,
        options,
      ),
    syncSourceMetadata: (
      sourceId: string,
      input: SourceSchemaSyncInput,
      options?: CallOptions,
    ) =>
      call(
        `/sources/${segment(sourceId)}/metadata`,
        SourceSchemaSyncResultSchema,
        "PUT",
        parseInput(SourceSchemaSyncInputSchema, input),
        options,
      ),
    configureSourceMetadata: (
      sourceId: string,
      input: SourceConfigurationInput,
      options?: CallOptions,
    ) =>
      call(
        `/sources/${segment(sourceId)}/configuration`,
        SourceSchemaStateSchema,
        "PUT",
        parseInput(SourceConfigurationInputSchema, input),
        options,
      ),
    effectiveSourceSchema: (sourceId: string, options?: CallOptions) =>
      call(
        `/sources/${segment(sourceId)}/effective-schema`,
        SourceEffectiveSchemaSchema,
        "GET",
        undefined,
        options,
      ),
    schema: (sourceId: string, options?: CallOptions) =>
      call(
        `/sources/${segment(sourceId)}/schema`,
        PatchContentSchemaResponseSchema,
        "GET",
        undefined,
        options,
      ),
    targets: (
      sourceId: string,
      field: string,
      after?: string,
      options?: CallOptions,
    ) =>
      call(
        `/sources/${segment(sourceId)}/relations/${segment(field)}${query({ after })}`,
        PatchRelationPageSchema,
        "GET",
        undefined,
        options,
      ),
    read: (
      sourceId: string,
      input: PatchContentQueryInput = {},
      options?: CallOptions,
    ) =>
      call(
        `/sources/${segment(sourceId)}/records/query`,
        PatchContentPageSchema,
        "POST",
        parseInput(ContentQueryInputSchema, input),
        options,
      ),
    propose: async (input: PatchProposalInput, options?: CallOptions) => {
      const result = await call(
        "/patches",
        PatchPreparedSchema,
        "POST",
        parseInput(PatchProposalInputSchema, input),
        options,
      );
      return { ...result, reviewUrl: `${origin}${result.reviewPath}` };
    },
    patch: (id: string, options?: CallOptions) =>
      call(
        `/patches/${segment(id)}`,
        PatchResponseSchema,
        "GET",
        undefined,
        options,
      ),
    patches: (
      input: { after?: string; limit?: number } = {},
      options?: CallOptions,
    ) =>
      call(
        `/patches${query(input)}`,
        PatchListSchema,
        "GET",
        undefined,
        options,
      ),
    history: (
      id: string,
      input: { after?: string; recordId?: string; limit?: number } = {},
      options?: CallOptions,
    ) =>
      call(
        `/patches/${segment(id)}/history${query(input)}`,
        PatchHistorySchema,
        "GET",
        undefined,
        options,
      ),
    decide: (id: string, input: PatchDecisionInput, options?: CallOptions) =>
      call(
        `/patches/${segment(id)}/decision`,
        PatchResponseSchema,
        "POST",
        parseInput(PatchDecisionInputSchema, input),
        options,
      ),
    apply: (id: string, input: PatchApplyInput, options?: CallOptions) =>
      call(
        `/patches/${segment(id)}/apply`,
        PatchAppliedSchema,
        "POST",
        parseInput(PatchApplyInputSchema, input),
        options,
      ),
  };
}
export type PatchctlClient = ReturnType<typeof createPatchctlClient>;
