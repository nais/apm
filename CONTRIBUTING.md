# Contributing to `@nais/apm`

Contributions are welcome. For minor changes, open a pull request directly. For
larger changes or new features, open an issue first so we can discuss the approach.

## Prerequisites

- **Node.js 22** — use [`mise`](https://mise.jdx.dev/) (`mise install`) to get the
  pinned version from [`mise.toml`](mise.toml). CI and release tooling also run on 22.
- **pnpm** — the repo pins the version via `packageManager` in `package.json`;
  `corepack enable` (or `mise`) will provision the right one.

## Getting started

```bash
git clone https://github.com/nais/apm.git
cd apm
pnpm install
```

Common tasks (also available via `mise run <task>`):

```bash
pnpm test        # run the vitest unit tests
pnpm build       # typecheck + emit dist/ (tsc -p tsconfig.build.json)
pnpm typecheck   # typecheck only, no emit
```

## Load-bearing dependency pins — do NOT bump

Two pins protect the session-replay privacy floor. Read
[`RELEASING.md` → "Dependency pins"](RELEASING.md#dependency-pins-load-bearing--read-before-bumping)
before touching them:

- **`@grafana/rrweb` and `@grafana/rrweb-snapshot` are pinned to the EXACT fork
  version `2.0.0-grafana.2`** (no `^`). The masking floor is written against this
  fork's behavior; moving the pin can silently change masking and cause a PII
  regression in shared Loki.
- **Keep the whole `@grafana/faro-*` family on one version.** A `faro-web-sdk`
  bump can transitively move the rrweb fork, so re-validate replay masking before
  any faro upgrade and move the three faro packages (`faro-web-sdk`,
  `faro-web-tracing`, `faro-react`) together.

Dependabot is configured to ignore the rrweb fork entirely and to defer the next
faro major, but manual bumps still need the same care.

## Commit messages: Conventional Commits

Every commit must be a valid [Conventional Commit](https://www.conventionalcommits.org/).
The `commitlint` CI job enforces this on every PR, and
[release-please](https://github.com/googleapis/release-please-action) infers the
next version and generates the changelog from these types:

- `feat:` → **minor** bump (pre-1.0: minor)
- `fix:` → **patch** bump
- `feat!:` / `fix!:` / a `BREAKING CHANGE:` footer → **minor** bump while pre-1.0
  (see `bump-minor-pre-major`)
- `docs:`, `chore:`, `ci:`, `test:`, `refactor:` → no release

## Releases (automated)

You never bump the version, tag, or publish by hand. On each push to `main`,
release-please maintains a single **Release PR** (`chore(main): release X.Y.Z`)
that computes the next version, rewrites `CHANGELOG.md`, and bumps
`package.json`. **Merging that Release PR** cuts the tag + GitHub Release and
publishes to the **GitHub Package Registry (GHPR)** from the same workflow run.

See [`RELEASING.md`](RELEASING.md) for the full flow, including the
`GITHUB_TOKEN` gotcha and the GHPR / npm-provenance notes.
