import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  localizationSourceRevision,
  modelLocalizationEntries,
} from "./dist/local/localization-entries.js";

test("portable source revision matches SHA-256 of the canonical tuple", () => {
  const tuple = ["en", "checkout.pay", "Pay now"];
  assert.equal(
    localizationSourceRevision(...tuple),
    createHash("sha256").update(JSON.stringify(tuple)).digest("hex"),
  );
});

const snapshot = {
  sourceId: "source-id",
  repositoryUrl: "https://github.com/example/app.git",
  baseBranch: "main",
  commitSha: "a".repeat(40),
  baseLocale: "en",
  files: [
    {
      locale: "en",
      path: "locales/en.json",
      blobSha: "b".repeat(40),
      entries: [
        { key: "checkout.pay", text: "Pay now" },
        { key: "checkout.cancel", text: "Cancel" },
        { key: "help", text: "Help" },
        { key: "checkout.empty", text: "Empty" },
      ],
    },
    {
      locale: "de",
      path: "locales/de.json",
      blobSha: "c".repeat(40),
      entries: [
        { key: "checkout.pay", text: "Jetzt bezahlen" },
        { key: "checkout.empty", text: "  " },
        { key: "help", text: "Hilfe" },
      ],
    },
  ],
};

test("missing, translated, stale, and unverified entries use recorded source revisions", () => {
  const payRevision = localizationSourceRevision(
    "en",
    "checkout.pay",
    "Pay now",
  );
  const oldHelpRevision = localizationSourceRevision("en", "help", "Old help");
  const entries = modelLocalizationEntries(snapshot, [
    { targetLocale: "de", key: "checkout.pay", sourceRevision: payRevision },
    { targetLocale: "de", key: "help", sourceRevision: oldHelpRevision },
  ]);
  assert.deepEqual(
    entries.map(({ key, status }) => [key, status]),
    [
      ["checkout.cancel", "missing"],
      ["checkout.empty", "missing"],
      ["checkout.pay", "translated"],
      ["help", "stale"],
    ],
  );
  assert.equal(entries[0].namespace, "checkout");
  assert.equal(entries[0].sourceText, "Cancel");
  assert.equal(entries[0].targetText, null);
  assert.equal(entries[1].targetText, "  ");
  assert.equal(entries[2].sourceRevision, payRevision);
  assert.equal(entries[2].targetPath, "locales/de.json");
  assert.equal(entries[3].namespace, null);
  assert.equal(
    modelLocalizationEntries(snapshot).find((entry) => entry.key === "help")
      .status,
    "unverified",
  );
});

test("source edits make tracked translations stale and normalization is deterministic", () => {
  const baseline = [
    {
      targetLocale: "de",
      key: "checkout.pay",
      sourceRevision: localizationSourceRevision(
        "en",
        "checkout.pay",
        "Pay now",
      ),
    },
  ];
  const changed = structuredClone(snapshot);
  changed.files[0].entries.find((entry) => entry.key === "checkout.pay").text =
    "Pay today";
  assert.equal(
    modelLocalizationEntries(changed, baseline).find(
      (entry) => entry.key === "checkout.pay",
    ).status,
    "stale",
  );
  changed.files.reverse();
  changed.files[0].entries.reverse();
  changed.files[1].entries.reverse();
  assert.deepEqual(
    modelLocalizationEntries(changed, baseline),
    modelLocalizationEntries(
      { ...changed, files: [...changed.files].reverse() },
      baseline,
    ),
  );
  assert.throws(
    () => modelLocalizationEntries(snapshot, [...baseline, ...baseline]),
    { code: "INVALID_SOURCE_BASELINE" },
  );
  assert.throws(
    () =>
      modelLocalizationEntries(snapshot, [
        { ...baseline[0], targetLocale: "fr" },
      ]),
    { code: "INVALID_SOURCE_BASELINE" },
  );
});
