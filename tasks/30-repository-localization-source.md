# Repository localization source (#30)

## Context and scope

- Issue: https://github.com/oneway8x-com/PatchCTL/issues/30
- Branch: `codex/repository-localization`; local commit and later maintainer review. No push or PR requested.
- Outcome: configure a Tenant-scoped repository source and discover bounded flat JSON locale files read-only at a Git base revision.

## Implementation notes

- `apps/cli/src/local/repository-localization.ts` validates repository identity, branch, locale paths, regular blobs, JSON structure, size limits, and deterministic entry ordering.
- `config.json` can hold repository localization sources separately from Postgres sources. `patchctl sources` lists them. The richer localization CLI and proposal workflow belong to #33.
- The configured clone is read locally. Discovery does not fetch; a caller must update remote refs before expecting a newer base revision.

## Verification

- Passed: `pnpm typecheck`.
- Passed: `pnpm --filter @corely/data exec prisma validate`.
- Passed: `pnpm arch:check`.
- Passed: `pnpm --filter patchctl test` (27 passed, 2 environment-dependent skips).
- Passed: `pnpm build`.
- Not run: database-backed `pnpm test`; no `PATCHCTL_TEST_DATABASE_URL` is configured, and this slice changes only local Git discovery.

## Handoff

- Delivered as a local ticket commit on the branch; not pushed. GitHub issue/board delivery state is recorded in the tracker.
- Remaining scope: #31 adds semantic missing/stale status; #33 adds agent-facing localization commands.
