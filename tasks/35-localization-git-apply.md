# Approved localization Git apply (#35)

## Scope

- Issue: https://github.com/oneway8x-com/PatchCTL/issues/35
- Branch: `codex/repository-localization`; local ticket commit and later maintainer review. No push or PR of PatchCTL code requested.
- A human `apply` session credential is required for `patchctl localization apply`; the agent proposal token is refused. The hosted Patch use case requires an exact approved revision and records STARTED, APPLIED/CONFLICT, and a durable commit/PR receipt.
- The local command verifies the configured origin, pinned base commit, source and target text, target blob, and structural validation. Git plumbing creates the reviewed tree in a temporary index, then pushes deterministic `patchctl/l10n/<patch-id>` and opens a GitHub PR. It never edits the current checkout or merges the PR.
- Retrying reconciles an existing matching PR/commit, including after the base branch moves. An interrupted push without a PR is recoverable only while the remote base still matches; otherwise a human must inspect the orphan branch and prepare a new Patch.

## Verification

- Passed: isolated bare-repository CLI tests with a simulated GitHub CLI for exact file diff, source/target conflicts, deterministic commit, PR base, no duplicate PR, retry after base movement, and no working-tree edit.
- Passed: Patch use-case tests for agent denial, human-only STARTED/APPLIED, immutable revision, and idempotent receipt.
- Passed: `pnpm typecheck`, Prisma validation, `pnpm arch:check`, API client Node tests (2), CLI tests (36 passed, 2 environment skips), Patch use-case unit tests (5), PatchCTL E2E TypeScript check, and `pnpm build`.
- Passed: mocked Chromium review suite (5 tests); applied receipt screenshot inspected.
- Database-backed `pnpm test` not run because `PATCHCTL_TEST_DATABASE_URL` is not configured.
- Real GitHub push/PR creation intentionally not exercised against an external repository. No production repository or database was changed.
