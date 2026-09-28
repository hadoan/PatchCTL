# Agent-facing localization CLI (#33)

## Context and scope

- Issue: https://github.com/oneway8x-com/PatchCTL/issues/33
- Branch: `codex/repository-localization`; local ticket commit and later maintainer review. No push or PR requested.
- Outcome: bounded JSON discovery, immutable local proposal draft, validation, and submission into the existing human Patch decision lifecycle.

## Implementation notes

- Added `localization` CLI commands for locales, missing/stale, get, start, set, diff, validate, login, and submit. The draft records source/target baselines and a base commit; validation checks them again before submission. Commands do not mutate Git.
- A human can provision a scoped repository localization source/token; the server verifies proposal repository identity, base branch, locale paths, and structural validation. The shared ICU validator moved to `@patchctl/localization` so CLI and server use the same rules.
- Review decisions for localization are temporarily rejected with `REVIEW_UNAVAILABLE` until #34 supplies the human comparison view. The UI displays that state without trying to render Postgres fields. #35 owns Git apply.
- Source revision baselines can be supplied in local source configuration for stale discovery; durable provenance integration follows in #35.

## Verification

- Passed: CLI fixture workflow and `pnpm --filter patchctl test`; source and target files were unchanged through submission.
- Passed: Patch use-case unit test for source allowlist, agent decision denial, and exact revision submission.
- Passed: `pnpm typecheck`, Prisma validate, and `pnpm arch:check`.
- Passed: `pnpm build`, PatchCTL E2E TypeScript check, and mocked Chromium review hold test (`playwright.patchctl-localization.config.ts`); screenshot inspected.
- Not run: database-backed `pnpm test`; no `PATCHCTL_TEST_DATABASE_URL` is configured.

## Handoff

- Local commit and issue/board update pending.
- Remaining scope: localization-aware review (#34), approved Git apply (#35), and real end-to-end coverage (#36).
