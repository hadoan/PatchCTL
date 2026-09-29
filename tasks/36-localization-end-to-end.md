# Localization end-to-end verification (#36)

## Scope

- Issue: https://github.com/oneway8x-com/PatchCTL/issues/36
- Branch: `codex/repository-localization`; local ticket commit. No push or PatchCTL PR requested.
- A dedicated Playwright config runs the real CLI, hosted API, Chromium review UI, and disposable PostgreSQL. The test creates a local Git fixture with English and German JSON files and a bare remote. A fixture `gh` executable simulates PR metadata; no live GitHub repository is changed.
- The scenario discovers a missing German key, submits `Abbrechen`, denies agent approval and apply, records human approval of the exact revision, creates one translation-only commit and PR receipt, and proves that retry does not create another PR. It then changes the English source before a second apply and checks the conflict, unchanged Git object and branch counts, and no second PR.
- The Git apply preflight checks the remote base before creating any Git object for a new PR. This makes the stale-source conflict leave Git untouched.

## Verification

- Passed: `pnpm --filter @corely/e2e exec playwright test -c playwright.patchctl-localization-e2e.config.ts` (1 full-stack scenario) against disposable `patchctl_l10n_test` on loopback port 55439.
- Passed: `pnpm --filter @corely/e2e exec tsc -p tsconfig.patchctl.json`, `pnpm typecheck`, Prisma validation, `pnpm arch:check`, `pnpm test` (196 tests), and `pnpm build`.
- Real GitHub PR creation remains unexercised. The PR provider is simulated, while local Git commit and push run against the disposable bare remote.
