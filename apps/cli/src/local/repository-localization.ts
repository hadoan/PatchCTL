import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { LocalError } from "./errors.js";

const runFile = promisify(execFile);
const locale = z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
const localePath = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.json$/)
  .refine((value) =>
    value
      .split("/")
      .every((part) => part !== "." && part !== ".." && part !== ""),
  );

export const RepositoryLocalizationSourceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    type: z.literal("repository-localization"),
    repositoryUrl: z
      .string()
      .max(500)
      .refine(
        (value) =>
          /^https:\/\/[^\s]+$/.test(value) ||
          /^ssh:\/\/[^\s]+$/.test(value) ||
          /^git@[^\s:]+:[^\s]+$/.test(value),
      ),
    checkoutPath: z.string().min(1).refine(isAbsolute),
    baseBranch: z
      .string()
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
      .refine((value) => !value.includes("..") && !value.includes("//")),
    baseLocale: locale,
    locales: z.array(locale).min(2).max(20),
    paths: z.record(locale, localePath),
  })
  .strict()
  .superRefine((source, context) => {
    if (new Set(source.locales).size !== source.locales.length)
      context.addIssue({
        code: "custom",
        path: ["locales"],
        message: "Locales must be unique.",
      });
    if (!source.locales.includes(source.baseLocale))
      context.addIssue({
        code: "custom",
        path: ["baseLocale"],
        message: "Base locale must be configured.",
      });
    if (
      Object.keys(source.paths).length !== source.locales.length ||
      source.locales.some((item) => !source.paths[item])
    )
      context.addIssue({
        code: "custom",
        path: ["paths"],
        message: "Each configured locale needs exactly one path.",
      });
    if (
      new Set(Object.values(source.paths)).size !==
      Object.keys(source.paths).length
    )
      context.addIssue({
        code: "custom",
        path: ["paths"],
        message: "Locale paths must be unique.",
      });
  });

export type RepositoryLocalizationSource = z.infer<
  typeof RepositoryLocalizationSourceSchema
>;
export type DiscoveredLocaleFile = {
  locale: string;
  path: string;
  blobSha: string;
  entries: { key: string; text: string }[];
};
export type RepositoryLocalizationSnapshot = {
  sourceId: string;
  repositoryUrl: string;
  baseBranch: string;
  commitSha: string;
  baseLocale: string;
  files: DiscoveredLocaleFile[];
};

async function git(
  directory: string,
  args: string[],
  maxBuffer = 2_200_000,
): Promise<string> {
  try {
    const { stdout } = await runFile("git", ["-C", directory, ...args], {
      timeout: 10_000,
      maxBuffer,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    return stdout.trimEnd();
  } catch {
    throw new LocalError(
      "REPOSITORY_UNAVAILABLE",
      "Could not read the configured Git repository or revision.",
    );
  }
}

function parseEntries(
  content: string,
  path: string,
): DiscoveredLocaleFile["entries"] {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new LocalError(
      "INVALID_LOCALE_FILE",
      `Configured locale file ${path} is not valid JSON.`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LocalError(
      "UNSUPPORTED_LOCALE_FORMAT",
      `Configured locale file ${path} must be a flat JSON object of strings.`,
    );
  const entries = Object.entries(value);
  if (
    entries.length > 10_000 ||
    entries.some(
      ([key, text]) =>
        !key ||
        key.length > 512 ||
        typeof text !== "string" ||
        text.length > 100_000,
    )
  )
    throw new LocalError(
      "UNSUPPORTED_LOCALE_FORMAT",
      `Configured locale file ${path} must contain at most 10,000 string entries with bounded keys and values.`,
    );
  return entries
    .map(([key, text]) => ({ key, text: text as string }))
    .sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    );
}

/** Read only the configured JSON blobs from a pinned base-branch commit. */
export async function discoverRepositoryLocalization(
  input: unknown,
): Promise<RepositoryLocalizationSnapshot> {
  const parsed = RepositoryLocalizationSourceSchema.safeParse(input);
  if (!parsed.success)
    throw new LocalError(
      "INVALID_SOURCE_CONFIG",
      "Repository localization source configuration is invalid. Only safe relative .json locale paths are supported.",
    );
  const source = parsed.data;
  const directory = await realpath(source.checkoutPath).catch(() => {
    throw new LocalError(
      "REPOSITORY_UNAVAILABLE",
      "Configured repository checkout is unavailable.",
    );
  });
  if ((await git(directory, ["rev-parse", "--show-toplevel"])) !== directory)
    throw new LocalError(
      "INVALID_SOURCE_CONFIG",
      "Checkout path must be the configured repository root.",
    );
  if (
    (await git(directory, ["remote", "get-url", "origin"])) !==
    source.repositoryUrl
  )
    throw new LocalError(
      "REPOSITORY_MISMATCH",
      "Checkout origin does not match the configured repository identity.",
    );
  const remoteRef = `refs/remotes/origin/${source.baseBranch}^{commit}`;
  let commitSha: string;
  try {
    commitSha = await git(directory, ["rev-parse", "--verify", remoteRef]);
  } catch {
    commitSha = await git(directory, [
      "rev-parse",
      "--verify",
      `refs/heads/${source.baseBranch}^{commit}`,
    ]);
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha))
    throw new LocalError(
      "REPOSITORY_UNAVAILABLE",
      "Configured base branch did not resolve to a Git commit.",
    );
  const files: DiscoveredLocaleFile[] = [];
  for (const item of [...source.locales].sort()) {
    const path = source.paths[item];
    const tree = await git(directory, ["ls-tree", commitSha, "--", path], 2048);
    const match =
      /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(tree);
    if (!match || match[3] !== path)
      throw new LocalError(
        "UNSUPPORTED_LOCALE_FORMAT",
        `Configured locale path ${path} must be a regular JSON file at the base revision.`,
      );
    const size = Number(
      await git(directory, ["cat-file", "-s", match[2]], 100),
    );
    if (!Number.isSafeInteger(size) || size > 2_000_000)
      throw new LocalError(
        "UNSUPPORTED_LOCALE_FORMAT",
        `Configured locale file ${path} exceeds the 2 MB limit.`,
      );
    const content = await git(directory, ["show", `${commitSha}:${path}`]);
    files.push({
      locale: item,
      path,
      blobSha: match[2],
      entries: parseEntries(content, path),
    });
  }
  return {
    sourceId: source.id,
    repositoryUrl: source.repositoryUrl,
    baseBranch: source.baseBranch,
    commitSha,
    baseLocale: source.baseLocale,
    files,
  };
}
