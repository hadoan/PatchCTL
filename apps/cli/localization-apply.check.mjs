import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyApprovedLocalizationPatch } from "./dist/local/localization-apply.js";
import { localizationSourceRevision } from "./dist/local/localization-entries.js";

const exec = promisify(execFile);

test("approved localization creates only the reviewed Git diff and reconciles PR retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchctl-git-apply-"));
  const repo = join(root, "repo");
  const bare = join(root, "remote.git");
  const bin = join(root, "bin");
  const prState = join(root, "pr.json");
  const previousPath = process.env.PATH;
  const previousState = process.env.GH_PR_STATE;
  const git = async (...args) =>
    (await exec("git", ["-C", repo, ...args])).stdout.trim();
  try {
    await mkdir(repo);
    await mkdir(bin);
    await exec("git", ["init", "--bare", bare]);
    await exec("git", ["init", "-b", "main", repo]);
    await git("config", "user.name", "Test");
    await git("config", "user.email", "test@example.test");
    await mkdir(join(repo, "locales"));
    await writeFile(
      join(repo, "locales/en.json"),
      '{\n  "checkout.cancel": "Cancel",\n  "checkout.pay": "Pay now"\n}\n',
    );
    await writeFile(
      join(repo, "locales/de.json"),
      '{\n  "checkout.pay": "Bezahlen"\n}\n',
    );
    await git("add", "locales");
    await git("commit", "-m", "Base locales");
    await git("remote", "add", "origin", bare);
    await git("push", "-u", "origin", "main");
    const baseCommitSha = await git("rev-parse", "HEAD");
    const targetBlobSha = await git("rev-parse", "HEAD:locales/de.json");
    const source = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Test",
      type: "repository-localization",
      repositoryUrl: `file://${bare}`,
      checkoutPath: repo,
      baseBranch: "main",
      baseLocale: "en",
      locales: ["en", "de"],
      paths: { en: "locales/en.json", de: "locales/de.json" },
    };
    await git("remote", "set-url", "origin", source.repositoryUrl);
    const proposal = {
      kind: "repository-localization",
      id: "22222222-2222-4222-8222-222222222222",
      connectionId: "33333333-3333-4333-8333-333333333333",
      repositoryUrl: source.repositoryUrl,
      baseBranch: "main",
      baseLocale: "en",
      baseCommitSha,
      title: "German checkout copy",
      createdAt: "2026-09-05T10:00:00.000Z",
      operations: [
        {
          id: "44444444-4444-4444-8444-444444444444",
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
          targetBlobSha,
          translationStatus: "missing",
          recordedSourceRevision: null,
        },
        {
          id: "66666666-6666-4666-8666-666666666666",
          key: "checkout.pay",
          sourceLocale: "en",
          sourceText: "Pay now",
          sourceRevision: localizationSourceRevision(
            "en",
            "checkout.pay",
            "Pay now",
          ),
          sourcePath: "locales/en.json",
          targetLocale: "de",
          targetBefore: "Bezahlen",
          targetAfter: "Jetzt bezahlen",
          targetPath: "locales/de.json",
          targetBlobSha,
          translationStatus: "unverified",
          recordedSourceRevision: null,
        },
      ],
    };
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const file = process.env.GH_PR_STATE;
if (args[0] !== 'pr') process.exit(2);
const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
if (args[1] === 'list') { process.stdout.write(JSON.stringify(existing ? [existing.pr] : [])); process.exit(0); }
if (args[1] === 'create') {
  if (existing) process.exit(3);
  const branch = args[args.indexOf('--head') + 1];
  const base = args[args.indexOf('--base') + 1];
  const commit = execFileSync('git', ['rev-parse', 'refs/heads/' + branch], { encoding: 'utf8' }).trim();
  const pr = { url: 'https://github.com/example/app/pull/1', headRefOid: commit, headRefName: branch, baseRefName: base, state: 'OPEN' };
  fs.writeFileSync(file, JSON.stringify({ pr, creates: 1 }));
  process.stdout.write(pr.url + '\\n'); process.exit(0);
}
if (args[1] === 'view' && existing) { process.stdout.write(JSON.stringify(existing.pr)); process.exit(0); }
process.exit(4);
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${previousPath}`;
    process.env.GH_PR_STATE = prState;
    const receipt = await applyApprovedLocalizationPatch(
      source,
      proposal,
      "a".repeat(64),
    );
    assert.equal(receipt.branch, `patchctl/l10n/${proposal.id}`);
    assert.equal(receipt.prUrl, "https://github.com/example/app/pull/1");
    assert.equal(
      await git("rev-parse", `${receipt.commitSha}^`),
      baseCommitSha,
    );
    assert.equal(
      await git(
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        receipt.commitSha,
      ),
      "locales/de.json",
    );
    assert.equal(
      await git("show", `${receipt.commitSha}:locales/en.json`),
      (await readFile(join(repo, "locales/en.json"), "utf8")).trim(),
    );
    assert.equal(
      await git("show", `${receipt.commitSha}:locales/de.json`),
      '{\n  "checkout.pay": "Jetzt bezahlen",\n  "checkout.cancel": "Abbrechen"\n}',
    );
    assert.equal(await git("status", "--porcelain"), "");
    assert.deepEqual(
      await applyApprovedLocalizationPatch(source, proposal, "a".repeat(64)),
      receipt,
    );
    assert.equal(JSON.parse(await readFile(prState, "utf8")).creates, 1);
    await assert.rejects(
      applyApprovedLocalizationPatch(
        source,
        {
          ...proposal,
          operations: [
            {
              ...proposal.operations[0],
              sourceText: "Permanently cancel",
              sourceRevision: localizationSourceRevision(
                "en",
                "checkout.cancel",
                "Permanently cancel",
              ),
            },
          ],
        },
        "a".repeat(64),
      ),
      { code: "PATCH_CONFLICT" },
    );
    await writeFile(
      join(repo, "locales/en.json"),
      '{\n  "checkout.cancel": "Permanently cancel",\n  "checkout.pay": "Pay now"\n}\n',
    );
    await git("add", "locales/en.json");
    await git("commit", "-m", "Change source after PR");
    await git("push", "origin", "main");
    assert.deepEqual(
      await applyApprovedLocalizationPatch(source, proposal, "a".repeat(64)),
      receipt,
    );
    await assert.rejects(
      applyApprovedLocalizationPatch(
        source,
        { ...proposal, id: "55555555-5555-4555-8555-555555555555" },
        "a".repeat(64),
      ),
      { code: "PATCH_CONFLICT" },
    );
    await assert.rejects(
      applyApprovedLocalizationPatch(
        source,
        {
          ...proposal,
          operations: [
            {
              ...proposal.operations[0],
              targetBefore: "Already changed",
              translationStatus: "unverified",
            },
          ],
        },
        "a".repeat(64),
      ),
      { code: "PATCH_CONFLICT" },
    );
  } finally {
    process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.GH_PR_STATE;
    else process.env.GH_PR_STATE = previousState;
    await rm(root, { recursive: true, force: true });
  }
});
