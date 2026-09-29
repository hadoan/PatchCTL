# patchctl

For local PostgreSQL setup, see the [local CLI guide](../../docs/local-cli.md). The
[customer getting-started guide](../../docs/customer-getting-started.md) separately documents the
incomplete reviewed-patch migration and its explicit hosted compatibility path.

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @corely/contracts build
pnpm --filter @corely/api-client build
pnpm --filter patchctl build
node apps/cli/dist/cli.js --help
```

The strict TypeScript source is `src/cli.ts`; `tsc` emits the Node.js executable to `dist/cli.js`.
Generated output is ignored by Git. The package declares the `patchctl` executable for
package-manager linking; no global installation is required.

## Local-first source commands

Customer Postgres credentials belong to the local CLI runtime. `connect` tests the database from
the user's machine, stores only a credential reference and non-secret source metadata in
`~/.patchctl/config.json`, and stores the DSN in the operating-system credential backend. The CLI
does not send that DSN to the PatchCTL HTTP service.

```text
patchctl connect postgres --tenant my-project
patchctl sources
patchctl init --resources public.articles --columns id,title
patchctl schema my-project
patchctl schema my-project articles
patchctl resources
patchctl list articles --limit 20
patchctl get articles 123
```

`PATCHCTL_DATABASE_URL` is an explicit process-only fallback for CI and disposable environments.
It takes precedence over the keyring and is never copied into PatchCTL config. Do not place it in
source control, command arguments, shell history, shared logs, or telemetry.

All successful output is JSON on stdout and structured errors are JSON on stderr. Connection and
credential failures use safe error messages and never include a password or complete DSN. This
boundary means PatchCTL does not expose or upload the credential; it cannot prevent an unrelated,
fully privileged process running as the same OS user from accessing machine-level secrets.

## Repository localization source (post-v0.1 foundation)

The local runtime can discover JSON locale files containing string translations in flat or
nested objects from a configured Git checkout without changing the checkout. A configuration
in `~/.patchctl/config.json` can include:

```json
{
  "tenants": {},
  "repositoryLocalization": {
    "demo": [
      {
        "id": "11111111-1111-4111-8111-111111111111",
        "name": "App translations",
        "type": "repository-localization",
        "repositoryUrl": "https://github.com/example/app.git",
        "checkoutPath": "/absolute/path/to/app",
        "baseBranch": "main",
        "baseLocale": "en",
        "locales": ["en", "de"],
        "paths": { "en": "locales/en.json", "de": "locales/de.json" }
      }
    ]
  }
}
```

`patchctl sources` lists the configured source. The discovery adapter reads only regular JSON
blobs at the local clone's configured base-branch commit and returns sorted string entries with
the commit and blob SHAs. It checks that the clone's `origin` exactly matches `repositoryUrl`.
Nested keys are represented with dot-separated paths (for example, `actions.cancel`). Arrays,
non-string leaves, ambiguous dotted paths, YAML, symlinks, and paths outside the configured
locale files are rejected. Configure one source per namespace when an app stores locales in
separate files. Discovery does not fetch remote changes.
Agent-facing localization discovery and proposal commands are tracked separately in #33.

The semantic model uses the source locale, key, and exact source text to make a stable SHA-256
source revision for each translation. A missing or whitespace-only target is `missing`. A target
with a recorded matching source revision is `translated`; a changed source is `stale`. Existing
target text with no recorded source revision is `unverified`, since PatchCTL cannot infer when
it was translated. Locally configured provenance baselines are included in immutable proposals;
the Git commit and PR receipt are stored with the Patch audit after application.

Structural proposal validation uses ICU MessageFormat parsing. It preserves named arguments and
their types, requires valid plural/select syntax with an `other` branch, and checks balanced
markup. The initial allowed rich-text tags are `b`, `strong`, `i`, `em`, `u`, `code`, and `link`;
tags with attributes and unknown tags are unsupported. ICU apostrophe quoting can escape syntax
characters. Validation reports machine-readable codes and source locations where available; it
does not assess language quality. See [FormatJS ICU syntax](https://formatjs.github.io/docs/core-concepts/icu-syntax/)
for the supported message grammar.

The agent-facing commands use a separate local localization draft and submit it to the normal
immutable Patch review service:

```text
patchctl localization locales
patchctl localization missing --locale de --json
patchctl localization stale --locale de --json
patchctl localization get checkout.cancel --locale de --json
patchctl localization start --title "German checkout copy"
patchctl localization set checkout.cancel --locale de --value Abbrechen
patchctl localization diff
patchctl localization validate
patchctl localization submit
```

`missing` and `stale` return at most 100 entries per call and support `--after`/`--limit`.
The local profile can be paired with a human-created, one-source token using
`patchctl localization login --server ORIGIN`. The hosted source configuration must match the
repository identity, base branch, locale paths, and base locale. A submitted revision cannot be
edited or approved with agent credentials. Git files stay unchanged through submission and
approval. The review page compares source, current target, and proposed target text before a
human can decide the exact revision.

After approval, a human with PatchCTL `apply` permission can run `patchctl localization apply`
with their session token in `PATCHCTL_APPLY_TOKEN`. This command does not use the agent proposal
token. It requires a local Git checkout with the configured `origin`, push access, and an
authenticated GitHub CLI (`gh`). It checks the remote base commit and every source and target
baseline before creating a deterministic `patchctl/l10n/<patch-id>` branch and a PR against the
configured base branch. It never writes locale files in the current working tree or merges the
PR. Retry the same command after a push, PR, or receipt-reporting interruption; it reconciles
the existing branch and PR. If the base or reviewed content changed before the first PR, prepare
a new Patch for human review.

## Hosted compatibility commands

The portable `@corely/api-client/patchctl` remains credential-free and Postgres-free. The older
server-connected implementation is retained only behind the explicit `server` namespace while the
review/apply migration is incomplete:

```text
patchctl server sources
patchctl server schema SOURCE_ID
patchctl server read SOURCE_ID --file query.json
patchctl server validate --file proposal.json
patchctl server propose --file proposal.json
patchctl server status PATCH_ID
patchctl server history PATCH_ID
```

This compatibility server must separately enable `PATCHCTL_LEGACY_SERVER_CONTENT=1`; it owns its
own configured DSN and does not receive the local CLI credential. Set `PATCHCTL_URL` and
`PATCHCTL_TOKEN` only for these explicit hosted commands. The local demo helper exercises this
compatibility path with `pnpm local:agent server ...`.

Use `--stdin` instead of `--file` to pipe JSON. Compatibility validation checks local structural
constraints without a token or mutation. Submission performs authoritative server-side checks and
returns a human review URL. Neither local database access nor coding-agent autonomy grants content
approval authority: agents propose, humans approve.
