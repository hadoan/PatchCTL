import { createHash } from "node:crypto";
import { LocalError } from "./errors.js";
import type {
  DiscoveredLocaleFile,
  RepositoryLocalizationSnapshot,
} from "./repository-localization.js";

export type TranslationSourceBaseline = {
  key: string;
  targetLocale: string;
  sourceRevision: string;
};

export type LocalizationEntry = {
  key: string;
  namespace: string | null;
  sourceLocale: string;
  sourceText: string;
  sourcePath: string;
  sourceRevision: string;
  sourceCommitSha: string;
  targetLocale: string;
  targetText: string | null;
  targetPath: string;
  targetBlobSha: string;
  status: "translated" | "missing" | "stale" | "unverified";
};

export function localizationSourceRevision(
  sourceLocale: string,
  key: string,
  sourceText: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([sourceLocale, key, sourceText]))
    .digest("hex");
}

function entriesByKey(file: DiscoveredLocaleFile): Map<string, string> {
  const entries = new Map<string, string>();
  for (const entry of file.entries) {
    if (entries.has(entry.key))
      throw new LocalError(
        "DUPLICATE_LOCALE_KEY",
        `Configured locale file ${file.path} contains a duplicate key.`,
      );
    entries.set(entry.key, entry.text);
  }
  return entries;
}

/** Normalize source/target text without making language-quality judgments. */
export function modelLocalizationEntries(
  snapshot: RepositoryLocalizationSnapshot,
  baselines: TranslationSourceBaseline[] = [],
): LocalizationEntry[] {
  const files = new Map<string, DiscoveredLocaleFile>();
  for (const file of snapshot.files) {
    if (files.has(file.locale))
      throw new LocalError(
        "INVALID_SOURCE",
        "Localization snapshot has duplicate locales.",
      );
    files.set(file.locale, file);
  }
  const source = files.get(snapshot.baseLocale);
  if (!source)
    throw new LocalError(
      "INVALID_SOURCE",
      "Localization snapshot has no base locale file.",
    );
  const sourceEntries = entriesByKey(source);
  const recorded = new Map<string, string>();
  for (const baseline of baselines) {
    const identity = JSON.stringify([baseline.targetLocale, baseline.key]);
    if (
      baseline.targetLocale === snapshot.baseLocale ||
      !files.has(baseline.targetLocale) ||
      !sourceEntries.has(baseline.key) ||
      !/^[a-f0-9]{64}$/.test(baseline.sourceRevision) ||
      recorded.has(identity)
    )
      throw new LocalError(
        "INVALID_SOURCE_BASELINE",
        "Translation source baselines must identify unique configured target entries and SHA-256 revisions.",
      );
    recorded.set(identity, baseline.sourceRevision);
  }
  const results: LocalizationEntry[] = [];
  for (const target of [...files.values()].sort((a, b) =>
    a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0,
  )) {
    if (target.locale === snapshot.baseLocale) continue;
    const targetEntries = entriesByKey(target);
    for (const [key, sourceText] of [...sourceEntries].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const targetText = targetEntries.get(key) ?? null;
      const sourceRevision = localizationSourceRevision(
        snapshot.baseLocale,
        key,
        sourceText,
      );
      const baseline = recorded.get(JSON.stringify([target.locale, key]));
      const status =
        targetText === null || targetText.trim().length === 0
          ? "missing"
          : baseline === undefined
            ? "unverified"
            : baseline === sourceRevision
              ? "translated"
              : "stale";
      results.push({
        key,
        namespace: key.includes(".") ? key.slice(0, key.indexOf(".")) : null,
        sourceLocale: snapshot.baseLocale,
        sourceText,
        sourcePath: source.path,
        sourceRevision,
        sourceCommitSha: snapshot.commitSha,
        targetLocale: target.locale,
        targetText,
        targetPath: target.path,
        targetBlobSha: target.blobSha,
        status,
      });
    }
  }
  return results;
}
