# Nested JSON localization source

## Scope

- A direct maintainer request to run PatchCTL against an application with nested locale JSON exposed a format gap in the initial flat-JSON source adapter.
- PatchCTL now reads nested objects with string leaves, flattens paths such as `actions.cancel`, and rejects duplicate or ambiguous paths, arrays, and non-string leaves. Git apply changes only reviewed string values or inserts reviewed nested keys while retaining unrelated file text.
- Applications with a file per namespace configure one repository-localization source per English/target-locale file pair.

## Verification

- Passed: nested JSON parser/apply unit tests and the isolated Git branch, commit, PR receipt, conflict, and retry test using synthetic fixture repositories. CLI suite: 39 passed, 2 environment skips.
- Passed: read-only discovery of 12 namespace pairs in a local application checkout (802 source entries, zero absent target keys). Existing translations have no recorded source revisions, so PatchCTL reports them as unverified.
- Passed: `pnpm typecheck`, Prisma validation, `pnpm arch:check`, `pnpm test` (196 tests), PatchCTL E2E TypeScript check, `pnpm build`, focused Prettier, and `git diff --check` using a verified disposable loopback `_test` database.
- Focused ESLint could not run because this checkout has no ESLint configuration file. The Next.js production build's lint/type step passed.
- No external application source file was edited, and no translation Patch was submitted, approved, or applied during the local run.
