import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeConfig } from "./dist/local/config.js";
import { runLocalizationCommand } from "./dist/local/localization-commands.js";

const run = promisify(execFile);

test("agent discovers, validates, and submits an immutable localization Patch without Git writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchctl-localization-flow-"));
  const repo = join(root, "app");
  const home = join(root, "home");
  const connectionId = randomUUID();
  const git = async (...args) =>
    (await run("git", ["-C", repo, ...args])).stdout.trim();
  const requests = [];
  try {
    await mkdir(join(repo, "locales"), { recursive: true });
    await git("init", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("remote", "add", "origin", "https://github.com/example/app.git");
    await writeFile(
      join(repo, "locales/en.json"),
      JSON.stringify({
        "checkout.pay": "Pay now",
        "checkout.cancel": "Cancel",
      }),
    );
    await writeFile(
      join(repo, "locales/de.json"),
      JSON.stringify({ "checkout.pay": "Jetzt bezahlen" }),
    );
    await git("add", "locales");
    await git("commit", "-m", "Locale fixture");
    const source = {
      id: randomUUID(),
      name: "App",
      type: "repository-localization",
      repositoryUrl: "https://github.com/example/app.git",
      checkoutPath: repo,
      baseBranch: "main",
      baseLocale: "en",
      locales: ["en", "de"],
      paths: { en: "locales/en.json", de: "locales/de.json" },
      server: {
        url: "https://patchctl.example",
        tenantId: "tenant-a",
        connectionId,
      },
    };
    await writeConfig(home, {
      tenants: {},
      currentTenant: "demo",
      repositoryLocalization: { demo: [source] },
    });
    const fetchImpl = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/me"))
        return Response.json({
          id: "agent-a",
          kind: "agent",
          ownerUserId: "owner-a",
          tenantId: "tenant-a",
          permissions: ["read", "propose"],
          connectionIds: [connectionId],
        });
      if (url.endsWith("/local-patches")) {
        const proposal = JSON.parse(init.body);
        return Response.json({
          id: proposal.id,
          tenantId: "tenant-a",
          revision: "a".repeat(64),
          status: "SUBMITTED",
          proposal,
          creator: { id: "agent-a", kind: "agent" },
          reviewerId: null,
          reviewedAt: null,
          appliedAt: null,
          failureCode: null,
          events: [
            {
              event: "PATCH_SUBMITTED",
              actor: { id: "agent-a", kind: "agent" },
              timestamp: new Date().toISOString(),
            },
          ],
        });
      }
      throw new Error("Unexpected HTTP request");
    };
    const invoke = async (args) => {
      let output = "",
        errors = "";
      const code = await runLocalizationCommand(["localization", ...args], {
        env: { PATCHCTL_HOME: home, PATCHCTL_TOKEN: "test-token" },
        fetchImpl,
        stdout: {
          write: (value) => {
            output += value;
          },
        },
        stderr: {
          write: (value) => {
            errors += value;
          },
        },
      });
      return {
        code,
        data: output ? JSON.parse(output) : null,
        error: errors ? JSON.parse(errors).error : null,
      };
    };
    assert.deepEqual((await invoke(["locales"])).data.locales, ["de", "en"]);
    const missing = await invoke(["missing", "--locale", "de"]);
    assert.equal(missing.data.entries[0].key, "checkout.cancel");
    assert.equal(missing.data.entries[0].sourceText, "Cancel");
    assert.equal(
      (await invoke(["get", "checkout.cancel", "--locale", "de"])).data.entry
        .status,
      "missing",
    );
    assert.equal(
      (await invoke(["start", "--title", "German checkout"])).code,
      0,
    );
    assert.equal(
      (
        await invoke([
          "set",
          "checkout.cancel",
          "--locale",
          "de",
          "--value",
          "Hallo {unexpected}",
        ])
      ).code,
      1,
    );
    assert.equal(
      (
        await invoke([
          "set",
          "checkout.cancel",
          "--locale",
          "de",
          "--value",
          "Abbrechen",
        ])
      ).code,
      0,
    );
    assert.equal(
      (await invoke(["diff"])).data.operations[0].targetAfter,
      "Abbrechen",
    );
    assert.equal((await invoke(["validate"])).data.valid, true);
    const statusBefore = await git("status", "--porcelain");
    const submitted = await invoke(["submit"]);
    assert.equal(submitted.code, 0);
    assert.equal(submitted.data.status, "SUBMITTED");
    assert.equal(await git("status", "--porcelain"), statusBefore);
    assert.equal(
      requests.filter((item) => item.url.endsWith("/local-patches")).length,
      1,
    );
    assert.equal(
      (
        await invoke([
          "set",
          "checkout.cancel",
          "--locale",
          "de",
          "--value",
          "Anders",
        ])
      ).error.code,
      "PATCH_ALREADY_SUBMITTED",
    );
    assert.equal(
      (await invoke(["submit"])).data.patchId,
      submitted.data.patchId,
    );
    await writeFile(
      join(repo, "locales/en.json"),
      JSON.stringify({
        "checkout.pay": "Pay now",
        "checkout.cancel": "Cancel forever",
      }),
    );
    await git("add", "locales/en.json");
    await git("commit", "-m", "Change source");
    assert.equal(
      (await invoke(["submit"])).data.patchId,
      submitted.data.patchId,
    );
    const conflict = await invoke(["validate"]);
    assert.equal(conflict.code, 1);
    assert.equal(conflict.data.errors[0].code, "SOURCE_CHANGED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
