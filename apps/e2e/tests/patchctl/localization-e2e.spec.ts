import { expect, test } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";

const exec = promisify(execFile);
const server = "http://127.0.0.1:3113";

test("real CLI, human review, and isolated Git PR receipt; changed source conflicts", async ({
  page,
  request,
}) => {
  const session = JSON.parse(
    await readFile(process.env.PATCHCTL_DEMO_SESSION!, "utf8"),
  ) as { url: string; tenantId: string; humanToken: string };
  const database = new URL(session.url);
  expect(["127.0.0.1", "localhost"].includes(database.hostname)).toBe(true);
  expect(
    /_(test|demo)$/.test(decodeURIComponent(database.pathname.slice(1))),
  ).toBe(true);
  const pool = new Pool({ connectionString: session.url });
  const root = await mkdtemp(join(tmpdir(), "patchctl-l10n-e2e-"));
  const repo = join(root, "repo");
  const bare = join(root, "remote.git");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const prState = join(root, "prs.json");
  const repoUrl = "https://github.com/example/localization-fixture.git";
  const realGit = (await exec("which", ["git"])).stdout.trim();
  const git = async (...args: string[]) =>
    (await exec(realGit, ["-C", repo, ...args])).stdout.trim();
  const apiHeaders = { Authorization: `Bearer ${session.humanToken}` };
  let connectionId = "";
  let agentToken = "";
  async function cli(args: string[], applyToken?: string) {
    return new Promise<{
      code: number;
      data: Record<string, unknown> | null;
      error: { code: string; message: string } | null;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../../../cli/dist/cli.js", import.meta.url)),
          "localization",
          ...args,
          "--json",
        ],
        {
          cwd: repo,
          stdio: "pipe",
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            SystemRoot: process.env.SystemRoot,
            TZ: process.env.TZ,
            PATCHCTL_HOME: home,
            PATCHCTL_TOKEN: agentToken,
            ...(applyToken ? { PATCHCTL_APPLY_TOKEN: applyToken } : {}),
            GH_PR_STATE: prState,
            REAL_GIT: realGit,
            PATCHCTL_FIXTURE_ORIGIN: repoUrl,
          },
        },
      );
      let output = "",
        error = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        error += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          resolve({
            code: code ?? 1,
            data: output ? JSON.parse(output) : null,
            error: error ? JSON.parse(error).error : null,
          });
        } catch {
          reject(new Error("CLI returned an invalid JSON result."));
        }
      });
      child.stdin.end();
    });
  }
  try {
    await mkdir(repo);
    await mkdir(home);
    await mkdir(bin);
    await exec(realGit, ["init", "--bare", bare]);
    await exec(realGit, ["init", "-b", "main", repo]);
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.test");
    await mkdir(join(repo, "locales"));
    await writeFile(
      join(repo, "locales/en.json"),
      '{\n  "checkout.cancel": "Cancel",\n  "checkout.pay": "Pay now"\n}\n',
    );
    await writeFile(
      join(repo, "locales/de.json"),
      '{\n  "checkout.pay": "Jetzt bezahlen"\n}\n',
    );
    await writeFile(join(repo, "README.md"), "Unrelated fixture content.\n");
    await git("add", "README.md", "locales");
    await git("commit", "-m", "Fixture base");
    await git("remote", "add", "origin", bare);
    await git("push", "-u", "origin", "main");
    const baseCommit = await git("rev-parse", "HEAD");
    await git("remote", "set-url", "origin", repoUrl);
    await git("config", `url.file://${bare}.insteadOf`, repoUrl);
    expect(
      (await git("ls-remote", "origin", "refs/heads/main")).split("\t")[0],
    ).toBe(baseCommit);
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh
if [ "$1" = "-C" ] && [ "$3" = "remote" ] && [ "$4" = "get-url" ] && [ "$5" = "origin" ]; then
  printf '%s\\n' "$PATCHCTL_FIXTURE_ORIGIN"
  exit 0
fi
exec "$REAL_GIT" "$@"
`,
      { mode: 0o755 },
    );
    await writeFile(
      join(bin, "gh"),
      `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const file = process.env.GH_PR_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { prs: [], creates: 0 };
if (args[0] !== 'pr') process.exit(2);
if (args[1] === 'list') {
  const head = args[args.indexOf('--head') + 1];
  process.stdout.write(JSON.stringify(state.prs.filter((pr) => pr.headRefName === head)));
  process.exit(0);
}
if (args[1] === 'create') {
  const head = args[args.indexOf('--head') + 1];
  const base = args[args.indexOf('--base') + 1];
  if (state.prs.some((pr) => pr.headRefName === head)) process.exit(3);
  const commit = execFileSync('git', ['rev-parse', 'refs/heads/' + head], { encoding: 'utf8' }).trim();
  const pr = { url: 'https://github.com/example/localization-fixture/pull/' + (state.creates + 1), headRefOid: commit, headRefName: head, baseRefName: base, state: 'OPEN' };
  state.prs.push(pr); state.creates++;
  fs.writeFileSync(file, JSON.stringify(state));
  process.stdout.write(pr.url + '\\n'); process.exit(0);
}
if (args[1] === 'view') {
  const pr = state.prs.find((item) => item.url === args[2]);
  if (!pr) process.exit(4);
  process.stdout.write(JSON.stringify(pr)); process.exit(0);
}
process.exit(5);
`,
      { mode: 0o755 },
    );
    const created = await request.post("/api/patchctl/local-client-token", {
      headers: apiHeaders,
      data: {
        type: "repository-localization",
        name: "Fixture translations",
        repositoryUrl: repoUrl,
        baseBranch: "main",
        baseLocale: "en",
        locales: ["en", "de"],
        paths: { en: "locales/en.json", de: "locales/de.json" },
      },
    });
    expect(created.status()).toBe(200);
    const token = (await created.json()) as {
      token: string;
      connectionId: string;
    };
    agentToken = token.token;
    connectionId = token.connectionId;
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        tenants: {},
        currentTenant: "fixture",
        repositoryLocalization: {
          fixture: [
            {
              id: randomUUID(),
              name: "Fixture translations",
              type: "repository-localization",
              repositoryUrl: repoUrl,
              checkoutPath: repo,
              baseBranch: "main",
              baseLocale: "en",
              locales: ["en", "de"],
              paths: { en: "locales/en.json", de: "locales/de.json" },
            },
          ],
        },
      }),
      { mode: 0o600 },
    );
    expect((await cli(["login", "--server", server])).code).toBe(0);
    const missing = await cli(["missing", "--locale", "de"]);
    expect(missing.code).toBe(0);
    expect(missing.data?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "checkout.cancel",
          sourceText: "Cancel",
          targetText: null,
          status: "missing",
        }),
      ]),
    );
    const existing = await cli(["get", "checkout.pay", "--locale", "de"]);
    expect(existing.data?.entry).toMatchObject({
      targetText: "Jetzt bezahlen",
      status: "unverified",
    });
    expect((await cli(["start", "--title", "German checkout"])).code).toBe(0);
    expect(
      (
        await cli([
          "set",
          "checkout.cancel",
          "--locale",
          "de",
          "--value",
          "Abbrechen",
        ])
      ).code,
    ).toBe(0);
    expect((await cli(["validate"])).data?.valid).toBe(true);
    const submitted = await cli(["submit"]);
    expect(submitted.code).toBe(0);
    const patchId = submitted.data?.patchId as string;
    const revision = submitted.data?.revision as string;
    expect(await git("status", "--porcelain")).toBe("");
    const denied = await request.post(
      `/api/patchctl/local-patches/${patchId}/decision`,
      {
        headers: { Authorization: `Bearer ${agentToken}` },
        data: { revision, decision: "APPROVED" },
      },
    );
    expect(denied.status()).toBe(403);
    const deniedApply = await request.post(
      `/api/patchctl/local-patches/${patchId}/execution-result`,
      {
        headers: { Authorization: `Bearer ${agentToken}` },
        data: { revision, status: "STARTED" },
      },
    );
    expect(deniedApply.status()).toBe(403);
    await page.addInitScript(
      (value) => localStorage.setItem("accessToken", value),
      session.humanToken,
    );
    await page.goto(`${server}/patches/${patchId}`);
    await expect(page.getByTestId("localization-diff")).toContainText("Cancel");
    await expect(page.getByTestId("localization-diff")).toContainText(
      "Abbrechen",
    );
    await page.screenshot({
      path: "./.patchctl-results/localization-e2e/review.png",
      fullPage: true,
    });
    const decision = page.waitForRequest((item) =>
      item.url().endsWith(`/${patchId}/decision`),
    );
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    expect((await decision).postDataJSON()).toEqual({
      revision,
      decision: "APPROVED",
    });
    await expect(page.getByTestId("patch-state")).toHaveText("APPROVED");
    expect((await cli(["apply"], agentToken)).error?.code).toBe("FORBIDDEN");
    const applied = await cli(["apply"], session.humanToken);
    expect(applied.code).toBe(0);
    expect(applied.data?.status).toBe("APPLIED");
    const receipt = applied.data as {
      branch: string;
      commitSha: string;
      prUrl: string;
    };
    expect(
      await git(
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        receipt.commitSha,
      ),
    ).toBe("locales/de.json");
    expect(await git("show", `${receipt.commitSha}:locales/de.json`)).toBe(
      '{\n  "checkout.pay": "Jetzt bezahlen",\n  "checkout.cancel": "Abbrechen"\n}',
    );
    expect(await git("show", `${receipt.commitSha}:README.md`)).toBe(
      "Unrelated fixture content.",
    );
    expect(await git("status", "--porcelain")).toBe("");
    expect((await cli(["apply"], session.humanToken)).data).toMatchObject(
      receipt,
    );
    const state = JSON.parse(await readFile(prState, "utf8"));
    expect(state.creates).toBe(1);
    expect(state.prs[0]).toMatchObject({
      baseRefName: "main",
      headRefOid: receipt.commitSha,
    });
    const stored = await request.get(`/api/patchctl/local-patches/${patchId}`, {
      headers: apiHeaders,
    });
    expect(await stored.json()).toMatchObject({
      status: "APPLIED",
      receipt: {
        branch: receipt.branch,
        commitSha: receipt.commitSha,
        prUrl: receipt.prUrl,
      },
      events: expect.arrayContaining([
        expect.objectContaining({ event: "PATCH_APPLIED" }),
      ]),
    });
    await page.reload();
    await expect(
      page.getByRole("link", { name: "Pull request" }),
    ).toHaveAttribute("href", receipt.prUrl);
    expect(
      (await cli(["start", "--title", "Stale German checkout"])).code,
    ).toBe(0);
    expect(
      (
        await cli([
          "set",
          "checkout.cancel",
          "--locale",
          "de",
          "--value",
          "Anders",
        ])
      ).code,
    ).toBe(0);
    const stale = await cli(["submit"]);
    expect(stale.code).toBe(0);
    const staleId = stale.data?.patchId as string;
    const staleRevision = stale.data?.revision as string;
    await page.goto(`${server}/patches/${staleId}`);
    await expect(page.getByTestId("localization-diff")).toContainText("Anders");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByTestId("patch-state")).toHaveText("APPROVED");
    await writeFile(
      join(repo, "locales/en.json"),
      '{\n  "checkout.cancel": "Permanently cancel",\n  "checkout.pay": "Pay now"\n}\n',
    );
    await git("add", "locales/en.json");
    await git("commit", "-m", "Change English source");
    await git("push", "origin", "main");
    const objectsBefore = await git("count-objects", "-v");
    const branchesBefore = await git(
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/patchctl/l10n",
    );
    const conflict = await cli(["apply"], session.humanToken);
    expect(conflict.error?.code).toBe("PATCH_CONFLICT");
    expect(await git("count-objects", "-v")).toBe(objectsBefore);
    expect(
      await git(
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads/patchctl/l10n",
      ),
    ).toBe(branchesBefore);
    expect(JSON.parse(await readFile(prState, "utf8")).creates).toBe(1);
    const blocked = await request.get(
      `/api/patchctl/local-patches/${staleId}`,
      { headers: apiHeaders },
    );
    expect(await blocked.json()).toMatchObject({
      status: "CONFLICT",
      failureCode: "PATCH_CONFLICT",
      events: expect.arrayContaining([
        expect.objectContaining({ event: "PATCH_CONFLICT" }),
      ]),
    });
    expect((await cli(["start", "--title", "New review required"])).code).toBe(
      0,
    );
  } finally {
    try {
      if (connectionId) {
        await pool.query(
          'DELETE FROM "LocalContentPatch" WHERE "tenantId"=$1 AND "connectionId"=$2',
          [session.tenantId, connectionId],
        );
        await pool.query(
          'DELETE FROM "ApiKey" WHERE "tenantId"=$1 AND $2=ANY("connectionIds")',
          [session.tenantId, connectionId],
        );
        await pool.query(
          'DELETE FROM "IntegrationConnection" WHERE "tenantId"=$1 AND id=$2',
          [session.tenantId, connectionId],
        );
      }
    } finally {
      await pool.end();
      await rm(root, { recursive: true, force: true });
    }
  }
});
