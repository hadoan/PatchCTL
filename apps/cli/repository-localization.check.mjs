import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  configuredRepositoryLocalization,
  readConfig,
  writeConfig,
} from "./dist/local/config.js";
import { discoverRepositoryLocalization } from "./dist/local/repository-localization.js";
import { runLocal } from "./dist/local/commands.js";

const run = promisify(execFile);
const repositoryUrl = "https://github.com/example/app.git";

test("configured JSON locale files are discovered read-only at a pinned Git commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchctl-localization-"));
  const repo = join(root, "app");
  const home = join(root, "home");
  const git = async (...args) =>
    (await run("git", ["-C", repo, ...args])).stdout.trim();
  try {
    await mkdir(join(repo, "locales"), { recursive: true });
    await git("init", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("remote", "add", "origin", repositoryUrl);
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
    await git("commit", "-m", "Initial locale files");
    const commit = await git("rev-parse", "HEAD");
    const source = {
      id: randomUUID(),
      name: "App translations",
      type: "repository-localization",
      repositoryUrl,
      checkoutPath: repo,
      baseBranch: "main",
      baseLocale: "en",
      locales: ["en", "de"],
      paths: { en: "locales/en.json", de: "locales/de.json" },
    };
    await assert.rejects(
      writeConfig(home, {
        tenants: {},
        repositoryLocalization: { demo: [source, source] },
      }),
      { code: "INVALID_CONFIG" },
    );
    await writeConfig(home, {
      tenants: {},
      repositoryLocalization: { demo: [source] },
    });
    let listed = "";
    assert.equal(
      await runLocal(["sources", "--json"], {
        env: { PATCHCTL_HOME: home },
        stdout: {
          write: (value) => {
            listed += value;
          },
        },
      }),
      0,
    );
    assert.deepEqual(JSON.parse(listed).sources, [
      { id: source.id, name: source.name, type: source.type },
    ]);
    const config = await readConfig(home);
    assert.deepEqual(
      configuredRepositoryLocalization(config, "demo", source.id),
      source,
    );
    assert.throws(
      () => configuredRepositoryLocalization(config, "other", source.id),
      { code: "SOURCE_NOT_FOUND" },
    );
    const before = await git("status", "--porcelain");
    const snapshot = await discoverRepositoryLocalization(source);
    assert.equal(snapshot.commitSha, commit);
    assert.deepEqual(
      snapshot.files.map((file) => file.locale),
      ["de", "en"],
    );
    assert.deepEqual(
      snapshot.files.find((file) => file.locale === "en").entries,
      [
        { key: "checkout.cancel", text: "Cancel" },
        { key: "checkout.pay", text: "Pay now" },
      ],
    );
    assert.match(snapshot.files[0].blobSha, /^[a-f0-9]{40}$/);
    assert.equal(await git("status", "--porcelain"), before);

    await git("branch", "stable", commit);
    await writeFile(
      join(repo, "locales/en.json"),
      JSON.stringify({ "checkout.pay": "Pay today" }),
    );
    await git("add", "locales/en.json");
    await git("commit", "-m", "Change source");
    const pinned = await discoverRepositoryLocalization({
      ...source,
      baseBranch: "stable",
    });
    assert.equal(pinned.commitSha, commit);
    assert.equal(
      pinned.files.find((file) => file.locale === "en").entries[1].text,
      "Pay now",
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(home, "config.json"), "utf8"))
        .repositoryLocalization.demo,
      [source],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository source rejects unconfigured paths, foreign origins, and unsupported files", async () => {
  const root = await mkdtemp(join(tmpdir(), "patchctl-localization-bad-"));
  const repo = join(root, "app");
  const git = async (...args) =>
    (await run("git", ["-C", repo, ...args])).stdout.trim();
  try {
    await mkdir(join(repo, "locales"), { recursive: true });
    await git("init", "-b", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    await git("remote", "add", "origin", repositoryUrl);
    await writeFile(
      join(repo, "locales/en.json"),
      JSON.stringify({ ok: "Value" }),
    );
    await writeFile(
      join(repo, "locales/de.json"),
      JSON.stringify({ ok: ["Unsupported"] }),
    );
    await symlink("en.json", join(repo, "locales/link.json"));
    await git("add", "locales");
    await git("commit", "-m", "Test files");
    const source = {
      id: randomUUID(),
      name: "App",
      type: "repository-localization",
      repositoryUrl,
      checkoutPath: repo,
      baseBranch: "main",
      baseLocale: "en",
      locales: ["en", "de"],
      paths: { en: "locales/en.json", de: "locales/de.json" },
    };
    await assert.rejects(
      discoverRepositoryLocalization({
        ...source,
        paths: { ...source.paths, en: "../secret.json" },
      }),
      { code: "INVALID_SOURCE_CONFIG" },
    );
    await assert.rejects(
      discoverRepositoryLocalization({
        ...source,
        paths: { ...source.paths, en: "locales/en.yaml" },
      }),
      { code: "INVALID_SOURCE_CONFIG" },
    );
    await assert.rejects(
      discoverRepositoryLocalization({
        ...source,
        repositoryUrl: "https://github.com/other/app.git",
      }),
      { code: "REPOSITORY_MISMATCH" },
    );
    await assert.rejects(discoverRepositoryLocalization(source), {
      code: "UNSUPPORTED_LOCALE_FORMAT",
    });
    await assert.rejects(
      discoverRepositoryLocalization({
        ...source,
        paths: { ...source.paths, de: "locales/missing.json" },
      }),
      { code: "UNSUPPORTED_LOCALE_FORMAT" },
    );
    await assert.rejects(
      discoverRepositoryLocalization({
        ...source,
        paths: { ...source.paths, de: "locales/link.json" },
      }),
      { code: "UNSUPPORTED_LOCALE_FORMAT" },
    );
    await writeFile(
      join(repo, "locales/en.json"),
      '{"checkout":{"cancel":"Cancel","pay":"Pay now"}}',
    );
    await writeFile(
      join(repo, "locales/de.json"),
      '{"checkout":{"pay":"Jetzt bezahlen"}}',
    );
    await git("add", "locales/en.json", "locales/de.json");
    await git("commit", "-m", "Nested locale files");
    const nested = await discoverRepositoryLocalization(source);
    assert.deepEqual(
      nested.files.find((file) => file.locale === "en").entries,
      [
        { key: "checkout.cancel", text: "Cancel" },
        { key: "checkout.pay", text: "Pay now" },
      ],
    );
    await writeFile(
      join(repo, "locales/de.json"),
      '{"checkout":{"pay":"First","\\u0070ay":"Second"}}',
    );
    await git("add", "locales/de.json");
    await git("commit", "-m", "Duplicate key");
    await assert.rejects(discoverRepositoryLocalization(source), {
      code: "DUPLICATE_LOCALE_KEY",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
