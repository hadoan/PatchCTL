import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  RepositoryLocalizationProposalSchema,
  type RepositoryLocalizationProposal,
} from "@corely/contracts";
import { validateLocalizationProposal } from "@patchctl/localization";
import { LocalError } from "./errors.js";
import { patchLocalizationJson } from "./localization-json.js";
import {
  discoverRepositoryLocalization,
  type RepositoryLocalizationSource,
} from "./repository-localization.js";

const exec = promisify(execFile);
type Operation = RepositoryLocalizationProposal["operations"][number];
const codeUnitOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export type LocalizationGitReceipt = {
  branch: string;
  commitSha: string;
  prUrl: string;
};

async function command(
  program: "git" | "gh",
  args: string[],
  directory: string,
  env: NodeJS.ProcessEnv = {},
  preserveOutput = false,
): Promise<string> {
  try {
    const { stdout } = await exec(program, args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2_200_000,
      env: {
        ...process.env,
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        ...env,
      },
    });
    return preserveOutput ? stdout : stdout.trim();
  } catch {
    throw new LocalError(
      program === "git" ? "REPOSITORY_UNAVAILABLE" : "PULL_REQUEST_UNAVAILABLE",
      program === "git"
        ? "Git operation failed; inspect the repository and retry the same approved Patch."
        : "Pull request operation failed; inspect the remote and retry the same approved Patch.",
    );
  }
}

function conflict(message: string): never {
  throw new LocalError("PATCH_CONFLICT", message);
}

function parsePr(
  value: string,
  branch: string,
  baseBranch: string,
  commitSha: string,
  repositoryUrl: string,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LocalError(
      "PULL_REQUEST_UNAVAILABLE",
      "Could not verify the pull request receipt.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new LocalError(
      "PULL_REQUEST_UNAVAILABLE",
      "Could not verify the pull request receipt.",
    );
  const pr = parsed as Record<string, unknown>;
  const githubRepository =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/.exec(
      repositoryUrl,
    );
  if (
    typeof pr.url !== "string" ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pr.url) ||
    (githubRepository &&
      !pr.url.startsWith(
        `https://github.com/${githubRepository[1]}/${githubRepository[2]}/pull/`,
      )) ||
    pr.headRefOid !== commitSha ||
    pr.headRefName !== branch ||
    pr.baseRefName !== baseBranch ||
    pr.state !== "OPEN"
  )
    conflict(
      "An existing pull request does not match the approved commit and base branch.",
    );
  return pr.url;
}

/** Create only the approved locale-file tree from the pinned base commit. */
export async function applyApprovedLocalizationPatch(
  source: RepositoryLocalizationSource,
  proposalInput: RepositoryLocalizationProposal,
  revision: string,
): Promise<LocalizationGitReceipt> {
  const proposal = RepositoryLocalizationProposalSchema.parse(proposalInput);
  if (
    source.repositoryUrl !== proposal.repositoryUrl ||
    source.baseBranch !== proposal.baseBranch ||
    source.baseLocale !== proposal.baseLocale
  )
    conflict("Configured repository identity changed after review.");
  const snapshot = await discoverRepositoryLocalization(
    source,
    proposal.baseCommitSha,
  );
  const directory = await realpath(source.checkoutPath);
  const groups = new Map<string, Operation[]>();
  for (const op of proposal.operations) {
    if (
      source.paths[op.sourceLocale] !== op.sourcePath ||
      source.paths[op.targetLocale] !== op.targetPath ||
      !source.locales.includes(op.targetLocale)
    )
      conflict("Patch targets an unconfigured locale path.");
    const sourceFile = snapshot.files.find(
      (file) => file.locale === op.sourceLocale,
    );
    const targetFile = snapshot.files.find(
      (file) => file.locale === op.targetLocale,
    );
    const sourceText = sourceFile?.entries.find(
      (entry) => entry.key === op.key,
    )?.text;
    const targetText =
      targetFile?.entries.find((entry) => entry.key === op.key)?.text ?? null;
    if (
      sourceText !== op.sourceText ||
      targetText !== op.targetBefore ||
      targetFile?.blobSha !== op.targetBlobSha
    )
      conflict("Source or target translation changed after review.");
    const validation = validateLocalizationProposal(
      {
        key: op.key!,
        sourceLocale: op.sourceLocale!,
        sourceText: op.sourceText!,
        sourceRevision: op.sourceRevision!,
        targetLocale: op.targetLocale!,
      },
      op.targetAfter!,
    );
    if (!validation.valid)
      conflict("Proposed translation failed structural validation.");
    groups.set(op.targetPath, [...(groups.get(op.targetPath) ?? []), op]);
  }
  const branch = `patchctl/l10n/${proposal.id}`;
  const priorList = await command(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "url,headRefOid,headRefName,baseRefName,state",
      "--limit",
      "100",
    ],
    directory,
  );
  let priorPrs: unknown;
  try {
    priorPrs = JSON.parse(priorList);
  } catch {
    throw new LocalError(
      "PULL_REQUEST_UNAVAILABLE",
      "Could not read existing pull requests.",
    );
  }
  if (!Array.isArray(priorPrs) || priorPrs.length > 1)
    conflict(
      "Pull request identity is ambiguous; inspect the remote before retrying.",
    );
  if (priorPrs.length === 0) {
    const remoteBase = await command(
      "git",
      ["ls-remote", "--heads", "origin", source.baseBranch],
      directory,
    );
    if (remoteBase.split("\t")[0] !== proposal.baseCommitSha)
      conflict("Remote base branch moved after this Patch was prepared.");
  }
  const temporary = await mkdtemp(join(tmpdir(), "patchctl-l10n-"));
  try {
    const indexEnv = { GIT_INDEX_FILE: join(temporary, "index") };
    const sourceOriginal = await command(
      "git",
      ["show", `${proposal.baseCommitSha}:${source.paths[source.baseLocale]}`],
      directory,
      {},
      true,
    );
    await command(
      "git",
      ["read-tree", proposal.baseCommitSha],
      directory,
      indexEnv,
    );
    let count = 0;
    for (const [path, operations] of [...groups].sort(([a], [b]) =>
      codeUnitOrder(a, b),
    )) {
      const original = await command(
        "git",
        ["show", `${proposal.baseCommitSha}:${path}`],
        directory,
        {},
        true,
      );
      const updated = patchLocalizationJson(
        original,
        sourceOriginal,
        operations,
        path,
      );
      if (Buffer.byteLength(updated) > 2_000_000)
        conflict("Configured locale file would exceed the 2 MB limit.");
      const filename = join(temporary, `file-${count++}.json`);
      await writeFile(filename, updated, { mode: 0o600 });
      const blob = await command(
        "git",
        ["hash-object", "-w", filename],
        directory,
      );
      const treeEntry = await command(
        "git",
        ["ls-tree", proposal.baseCommitSha, "--", path],
        directory,
      );
      const mode = /^(100644|100755) blob /.exec(treeEntry)?.[1];
      if (!mode) conflict("Configured locale path is not a regular file.");
      await command(
        "git",
        ["update-index", "--add", "--cacheinfo", mode, blob, path],
        directory,
        indexEnv,
      );
    }
    const tree = await command("git", ["write-tree"], directory, indexEnv);
    const commitSha = await command(
      "git",
      [
        "commit-tree",
        tree,
        "-p",
        proposal.baseCommitSha,
        "-m",
        `PatchCTL localization ${proposal.id}\n\nRevision: ${revision}`,
      ],
      directory,
      {
        GIT_AUTHOR_NAME: "PatchCTL",
        GIT_AUTHOR_EMAIL: "patchctl@users.noreply.github.com",
        GIT_AUTHOR_DATE: proposal.createdAt,
        GIT_COMMITTER_NAME: "PatchCTL",
        GIT_COMMITTER_EMAIL: "patchctl@users.noreply.github.com",
        GIT_COMMITTER_DATE: proposal.createdAt,
      },
    );
    const changed = (
      await command(
        "git",
        ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha],
        directory,
      )
    )
      .split("\n")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(changed) !== JSON.stringify([...groups.keys()].sort()))
      conflict("Generated commit includes unexpected file changes.");
    const ref = `refs/heads/${branch}`;
    const existing = await exec(
      "git",
      ["show-ref", "--verify", "--hash", ref],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 10_000,
      },
    ).then(
      (result) => result.stdout.trim(),
      () => null,
    );
    if (existing && existing !== commitSha)
      conflict(
        "The deterministic localization branch points to another commit.",
      );
    const list = await command(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "url,headRefOid,headRefName,baseRefName,state",
        "--limit",
        "100",
      ],
      directory,
    );
    let prs: unknown;
    try {
      prs = JSON.parse(list);
    } catch {
      throw new LocalError(
        "PULL_REQUEST_UNAVAILABLE",
        "Could not read existing pull requests.",
      );
    }
    if (!Array.isArray(prs) || prs.length > 1)
      conflict(
        "Pull request identity is ambiguous; inspect the remote before retrying.",
      );
    let prUrl: string;
    if (prs.length === 1) {
      prUrl = parsePr(
        JSON.stringify(prs[0]),
        branch,
        proposal.baseBranch,
        commitSha,
        proposal.repositoryUrl,
      );
      const remoteBranch = await command(
        "git",
        ["ls-remote", "origin", ref],
        directory,
      );
      if (remoteBranch.split("\t")[0] !== commitSha)
        conflict("Pull request branch does not match the reviewed commit.");
      return { branch, commitSha, prUrl };
    } else {
      const remote = await command(
        "git",
        ["ls-remote", "--heads", "origin", source.baseBranch],
        directory,
      );
      if (remote.split("\t")[0] !== proposal.baseCommitSha)
        conflict("Remote base branch moved after this Patch was prepared.");
      if (!existing)
        await command(
          "git",
          ["update-ref", ref, commitSha, "0".repeat(commitSha.length)],
          directory,
        );
      await command("git", ["push", "origin", `${ref}:${ref}`], directory);
      const body = join(temporary, "pr-body.md");
      await writeFile(
        body,
        `PatchCTL localization Patch ${proposal.id}\n\nApproved revision: ${revision}\n`,
        { mode: 0o600 },
      );
      const created = await command(
        "gh",
        [
          "pr",
          "create",
          "--base",
          proposal.baseBranch,
          "--head",
          branch,
          "--title",
          proposal.title,
          "--body-file",
          body,
        ],
        directory,
      );
      prUrl =
        created
          .split("\n")
          .find((line) => /^https:\/\/github\.com\//.test(line)) ?? "";
      if (!prUrl)
        throw new LocalError(
          "PULL_REQUEST_UNAVAILABLE",
          "Pull request creation returned no URL; retry to reconcile it.",
        );
      const detail = await command(
        "gh",
        [
          "pr",
          "view",
          prUrl,
          "--json",
          "url,headRefOid,headRefName,baseRefName,state",
        ],
        directory,
      );
      prUrl = parsePr(
        detail,
        branch,
        proposal.baseBranch,
        commitSha,
        proposal.repositoryUrl,
      );
    }
    return { branch, commitSha, prUrl };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
