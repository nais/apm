# Releasing `@nais/apm`

Releases are **fully automated with [release-please](https://github.com/googleapis/release-please-action)**.
As a maintainer you never run `pnpm publish`, never edit the version by hand, and never
create a tag or GitHub Release yourself. You only **merge PRs**.

## The flow, end to end

1. **Land work on `main` with Conventional Commits.** Every PR is squash/merged with a
   conventional message (`feat: …`, `fix: …`, `docs: …`, etc.). The `Commitlint`
   workflow (`.github/workflows/commitlint.yml`) enforces this on every PR.
2. **release-please maintains a "Release PR".** On each push to `main`, the `Release`
   workflow (`.github/workflows/release-please.yml`) runs release-please. It opens (or
   updates) a single **Release PR** titled like `chore(main): release 0.2.0` that:
   - computes the next version from the accumulated commits (feat ⇒ minor, fix ⇒ patch;
     pre-1.0, breaking changes also bump the minor — see `bump-minor-pre-major` in
     `release-please-config.json`),
   - rewrites `CHANGELOG.md`, and
   - bumps `version` in `package.json`.

   This PR keeps updating itself as more commits land. Nothing is published while it sits
   open.
3. **Merge the Release PR to release.** When you merge it, release-please creates the git
   tag (`vX.Y.Z`) and the GitHub Release, then the **same workflow run** publishes to the
   GitHub Package Registry (GHPR).

That's it. To cut a release: review and merge the bot's Release PR.

## The `GITHUB_TOKEN` gotcha (why publish lives in the release workflow)

A tag/Release created by the built-in `GITHUB_TOKEN` **does not** trigger other
workflows — this is GitHub's deliberate protection against workflow loops. So a separate
`publish.yaml` keyed on `release: published` would **silently never fire**.

To avoid that, publishing runs in a **second job of the release workflow itself**
(`publish`), gated on `if: needs.release-please.outputs.releases_created == 'true'`. When
release-please reports it created a release, that job checks out the new tag, re-runs
`pnpm test` + `pnpm build`, and runs `pnpm publish --no-git-checks` to GHPR using
`secrets.GITHUB_TOKEN` (same-org publish, no PAT needed). The old standalone
`publish.yaml` has been removed.

## What CI gates exist

**On every PR (`commitlint.yml`):** every commit in the PR must be a valid Conventional
Commit — this is what makes release-please's version inference trustworthy.

**On every PR / push to `main` (`ci.yaml`):**

- `pnpm test` (vitest) and `pnpm build` (tsc → `dist/`) must pass.
- **Pack verification:** `npm pack --dry-run` must contain `dist/` and must **not**
  contain any `src/` files.

**On a Release-PR merge (`release-please.yml` → `publish` job):**

- **Version/tag guard:** publishing fails if `package.json` version does not equal the
  release tag with its leading `v` stripped. release-please keeps these in lockstep, so
  this is a belt-and-suspenders check against drift.
- Full `pnpm test` + `pnpm build` run again before publish, at the tagged commit.
- Publishes to the `latest` dist-tag.

## Pre-releases

The previous manual `next` dist-tag pre-release flow is retired. If pre-releases are
needed again, configure a release-please prerelease channel (a `release-please-config.json`
`prerelease` setting on a dedicated branch) rather than hand-cutting one.

## The first release is pinned to 0.1.0

The manifest (`.release-please-manifest.json`) is seeded at `0.0.0` — the "not
yet released" sentinel. Because release-please falls back to its Node default
initial version of **1.0.0** for a first release from that sentinel (rather
than bumping `0.0.0 → 0.1.0`), the first version is pinned with a one-time
`Release-As: 0.1.0` footer on a `chore` commit. That footer applies only to the
first release and is ignored afterwards; from `0.1.0` onward, versions compute
normally from conventional commits (`feat` → minor, `fix` → patch, breaking →
minor while pre-1.0 via `bump-minor-pre-major`). Do **not** add a new
`Release-As` footer or a config-level `release-as` for routine releases.

## Manual escape hatch

There is intentionally **no** manual publish workflow — removing it prevents accidental
double-publishes. If you ever need to publish out of band, do it locally against a clean
checkout of the tag with `pnpm publish` and a token that can write to the org's GHPR.

## Dependency pins (load-bearing — read before bumping)

Two pin constraints protect the replay privacy floor. Treat both as load-bearing.

1. **`@grafana/rrweb` and `@grafana/rrweb-snapshot` are pinned to the EXACT version
   `2.0.0-grafana.2`** (no `^`). This is a Grafana *fork* of rrweb, imported only by
   `src/replay/*`. The non-overridable masking floor in `src/replay/masking.ts` is written
   against this fork's specific behavior (e.g. it doesn't expose `maskAttributeFn`, which is
   why `src/replay/transport.ts` scrubs the serialized payload as a backstop). **Moving this
   pin can silently change masking → a PII regression in shared Loki.** Do not bump or widen
   it without re-validating the masking floor.

2. **Keep the whole `@grafana/faro-*` family on one version.** `faro-web-sdk`,
   `faro-web-tracing`, and `faro-react` must match (currently `2.8.2`). Adding React (#79)
   and tracing (#80) for v0.2.0 needed **no faro bump** precisely because both already exist
   at 2.8.2 and neither depends on rrweb — so v0.2.0 never touched the replay fork pin. A
   future `faro-web-sdk` upgrade **could transitively move rrweb**, so **re-validate replay
   masking before any faro bump**, and bump the three faro packages together.

## A note on npm provenance

We publish to GHPR, which does **not** support npm build provenance/attestations — those
are a public-npm-registry (`registry.npmjs.org`) feature. The publish job deliberately
omits `--provenance`; see the comment in `.github/workflows/release-please.yml` for the
full rationale and what to change if the package ever moves to npmjs.org.
