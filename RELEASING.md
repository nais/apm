# Releasing `@nais/apm`

Maintainer guide for cutting a release. Releases are driven by **GitHub Releases**:
creating a published release triggers `.github/workflows/publish.yaml`, which builds
and publishes the package to the GitHub Package Registry (GHPR). You never run
`pnpm publish` by hand.

## Prerequisites

- The change you want to ship is already merged to `main` and green in CI.
- You have permission to push tags / create releases on `nais/apm`.

## Cutting a stable release

1. **Bump the version in a PR.** Edit `version` in `package.json` (semver; pre-1.0,
   so breaking changes may land in a minor `0.x` bump — see the CHANGELOG note).
   Update `CHANGELOG.md`: rename the `Unreleased`/current section to the new version
   with today's date, and make sure the entry reflects what actually changed. Open
   the PR, get it reviewed, merge to `main`.
2. **Create the GitHub release.** Once the version bump is on `main`, create a new
   GitHub release with tag `vX.Y.Z` (leading `v`) targeting `main`. The tag version
   **must** match `package.json` — the publish workflow fails otherwise (see Gates).
   Leave "Set as a pre-release" **unchecked**.
3. **Done.** Publishing the release runs `publish.yaml`: it verifies the version,
   installs, tests, builds, and runs `pnpm publish --tag latest` to GHPR.

## Cutting a pre-release

Same as above, but when creating the GitHub release, **check "Set as a pre-release"**.
The workflow detects `release.prerelease == true` and publishes under the `next`
dist-tag instead of `latest`, so `pnpm add @nais/apm` still resolves the last stable
version and testers opt in with `pnpm add @nais/apm@next`.

Use a pre-release tag such as `v0.2.0-rc.1` (keep `package.json` in lockstep:
`"version": "0.2.0-rc.1"`).

## What CI gates exist

**On every PR / push to `main` (`ci.yaml`):**

- `pnpm test` (vitest) and `pnpm build` (tsc → `dist/`) must pass.
- **Pack verification:** `npm pack --dry-run` must contain `dist/` and must **not**
  contain any `src/` files — this catches a broken `files` field before it ships a
  tarball with source instead of build output.

**On release publish (`publish.yaml`):**

- **Version/tag guard:** publishing fails if `package.json` version does not equal the
  release tag with its leading `v` stripped (tag `v1.2.3` ⇒ version `1.2.3`).
- Full `pnpm test` + `pnpm build` run again before publish.
- Stable releases publish to the `latest` dist-tag; pre-releases to `next`.

## A note on npm provenance

We publish to GHPR, which does **not** support npm build provenance/attestations —
those are a public-npm-registry (`registry.npmjs.org`) feature. So the publish
workflow deliberately omits `--provenance`. See the comment at the top of
`.github/workflows/publish.yaml` for the full rationale and what to change if the
package ever moves to npmjs.org.
