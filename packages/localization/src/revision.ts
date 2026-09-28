import { createHash } from "node:crypto";

export function localizationSourceRevision(
  sourceLocale: string,
  key: string,
  sourceText: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([sourceLocale, key, sourceText]))
    .digest("hex");
}
