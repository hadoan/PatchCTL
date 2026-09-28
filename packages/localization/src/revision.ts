import { hash } from "fast-sha256";

export function localizationSourceRevision(
  sourceLocale: string,
  key: string,
  sourceText: string,
): string {
  return Array.from(
    hash(
      new TextEncoder().encode(JSON.stringify([sourceLocale, key, sourceText])),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
