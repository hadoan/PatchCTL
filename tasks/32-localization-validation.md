# Deterministic localization validation (#32)

## Context and scope

- Issue: https://github.com/oneway8x-com/PatchCTL/issues/32
- Branch: `codex/repository-localization`; local ticket commit, then maintainer review. No push or PR requested.
- Outcome: validate translation structure with machine-readable errors and no LLM judgment.

## Implementation notes

- Uses the FormatJS ICU parser to check syntax, plural/select `other` branches, named arguments and types, and balanced markup. Rich-text tags are explicitly allowlisted. ICU apostrophe quoting is parsed by the library.
- Source revision checks make the same validator usable at proposal preparation and pre-apply revalidation. Malformed JSON files are rejected by the source adapter before entries reach this validator.
- This ticket adds the validator and tests. CLI proposal integration (#33) and apply-time wiring (#35) remain separate.

## Verification

- Passed: `pnpm --filter patchctl test` (33 passed, 2 environment-dependent skips).
- Passed: `pnpm typecheck`, Prisma validate, `pnpm arch:check`, and `pnpm build`.
- Not run: database-backed `pnpm test`; no `PATCHCTL_TEST_DATABASE_URL` is configured, and this slice is local structural validation.

## Handoff

- Delivered as a local ticket commit on the branch; not pushed. GitHub issue/board delivery state is recorded in the tracker.
- Remaining scope: CLI (#33), review UI (#34), Git apply (#35), and E2E (#36).
