# Localization entry model (#31)

## Context and scope

- Issue: https://github.com/oneway8x-com/PatchCTL/issues/31
- Branch: `codex/repository-localization`; local ticket commit, then maintainer review. No push or PR requested.
- Outcome: deterministic normalized source/target entries and honest missing/stale classification.

## Implementation notes

- The model derives per-key source revisions from source locale, key, and exact source text. It reports `stale` only when supplied provenance proves the target was translated from a different revision. Existing targets without provenance are `unverified`.
- Missing includes absent and whitespace-only target values. Flat JSON duplicate keys are rejected during discovery, including escaped duplicate spellings.
- #35 must persist approved translation baselines so future discovery can classify applied entries as translated or stale. This ticket defines and tests the model without claiming existing Git files carry that metadata.

## Verification

- Passed: `pnpm --filter patchctl test` (29 passed, 2 environment-dependent skips).
- Passed: `pnpm typecheck`, Prisma validate, `pnpm arch:check`, and `pnpm build`.
- Not run: database-backed `pnpm test`; no `PATCHCTL_TEST_DATABASE_URL` is configured, and this slice is pure local modeling and Git fixture discovery.

## Handoff

- Delivered as a local ticket commit on the branch; not pushed. GitHub issue/board delivery state is recorded in the tracker.
- Remaining scope: structural validation (#32), CLI (#33), review (#34), durable provenance/Git apply (#35), and E2E (#36).
