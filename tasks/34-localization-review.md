# Localization-aware review (#34)

## Scope

- Branch: `codex/repository-localization`; local ticket commit, no push or PR requested.
- The existing human Patch review now compares source, current target, and proposed target text for repository localization entries. It shows paths, locale summaries, recorded source revisions, translation status, structural validation, and filters.
- The existing exact-revision decision use case accepts human approval or rejection for localization proposals. Agent credentials remain unable to decide. Invalid structural content blocks approval; applying Git remains #35.
- Source/target Git revisions are captured in the immutable proposal. The hosted server does not fetch the repository; the local client must detect changes before apply in #35.

## Verification

- Passed: `pnpm build`, `pnpm typecheck`, CLI tests (35 passed, 2 environment skips), patch use-case unit tests (5 passed), Prisma schema validation, architecture check, PatchCTL E2E TypeScript check.
- Passed: mocked Chromium review suite (4 tests); desktop and mobile screenshots inspected. The first browser run had a mock that kept returning the submitted status after approval; corrected and reran successfully.
- Database-backed `pnpm test` not run because `PATCHCTL_TEST_DATABASE_URL` is not configured.
