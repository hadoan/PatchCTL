# Driver Points nested locale source

## Scope

- Direct maintainer request: run PatchCTL against the active TruckerPoints app under `truckerpoints-src/apps/driver-points/` using the local PatchCTL database.
- The earlier `backup/truckers-copilot` local source was removed. No TruckerPoints source file was edited.
- PatchCTL now reads nested JSON objects with string leaves, flattens keys such as `actions.cancel`, rejects ambiguous paths, duplicate keys, arrays, and non-string leaves, and applies only reviewed string replacements or nested additions while preserving unrelated file text.
- Driver Points has separate JSON files per namespace. Each English/German namespace pair is a separate PatchCTL source, pinned to the configured Git `main` revision.

## Verification

- Passed: nested JSON parser/apply unit tests, isolated Git branch/commit/PR receipt test using a nested fixture, and full CLI suite (39 passed, 2 environment skips).
- Passed: real read-only discovery of all 12 active Driver Points English/German namespace pairs at TruckerPoints `main` commit `58cfa97ac7ddf2309400e44efc447018bd4419ce` (802 source entries, zero absent German keys; all 802 existing translations remain unverified without provenance).
- Registered the 12 active namespace sources in the persistent local `patchctl_demo` database and an ignored, owner-only CLI profile under `.patchctl-demo/trucker-driver-localization/`. The local app returned HTTP 200. No translation Patch was submitted, approved, or applied.
- Passed: `pnpm typecheck`, Prisma validation, `pnpm arch:check`, `pnpm test` (196 tests), PatchCTL E2E TypeScript check, and `pnpm build` against a verified disposable loopback `_test` database.
- Focused ESLint was unavailable because this checkout has no ESLint configuration file; the production Next.js build's lint/type step passed. Prettier and `git diff --check` passed.
- TruckerPoints' own coverage command reports 21 German strings needing translation by its broader criteria. PatchCTL currently labels existing values without source-revision provenance `unverified`; it does not infer untranslated text from equality with English.
