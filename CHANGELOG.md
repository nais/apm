# Changelog

## [0.3.0](https://github.com/nais/apm/compare/apm-v0.2.0...apm-v0.3.0) (2026-07-05)


### Features

* **replay:** safe-default events tier for session replay ([#82](https://github.com/nais/apm/issues/82)) ([#7](https://github.com/nais/apm/issues/7)) ([754974b](https://github.com/nais/apm/commit/754974b69f17aef006e334ea99930b9d009c97bf))


### Bug Fixes

* **feedback:** bound email length to close CodeQL ReDoS finding ([#5](https://github.com/nais/apm/issues/5)) ([e083c73](https://github.com/nais/apm/commit/e083c73d946d6fba904a119e422cd67d1a39d00a))

## [Unreleased]

### BREAKING (PREVIEW)

- **Session replay now defaults to the `events` tier (no DOM)**
  ([#82](https://github.com/nais/grafana-apm-app/issues/82)). The PREVIEW
  `sessionReplay` option gains a distinct privacy-tier field
  (`tier?: 'events' | 'wireframe' | 'dom'`) that is independent of the capture
  trigger (`mode`, unchanged). `sessionReplay: { enabled: true }` with `tier`
  omitted now captures a lightweight, DOM-free **interaction timeline**
  (navigation, clicks, rage-clicks, coarse scroll — tag/role/coords/timestamps
  only) instead of the masked rrweb DOM recording it produced before.

  There is structurally no DOM node tree / `FullSnapshot` on the default path,
  so nothing can leak beyond URLs (which are already `scrubUrl`-sanitized). A
  one-time `console.warn` is emitted for enabled pilots relying on the old
  default.

  **Migration:** to keep the full masked DOM recording, pass
  `sessionReplay: { enabled: true, tier: 'dom' }` (still personvernombud-gated).
  `screenshotOnError` is likewise folded into the tier model: it produces a DOM
  snapshot only with `tier: 'dom'`, otherwise it degrades to a text-free
  events-tier breadcrumb (previously it emitted a masked DOM snapshot with no
  consent gate).

  This is contractually acceptable because `sessionReplay`/`screenshotOnError`
  are explicitly PREVIEW (not GA), but the ~handful of known pilots must be told.

## [0.2.0](https://github.com/nais/apm/compare/apm-v0.1.0...apm-v0.2.0) (2026-07-05)


### Features

* @nais/apm/react entry point + opt-in browser tracing (v0.2.0) ([23c5c17](https://github.com/nais/apm/commit/23c5c17a654d6415b8ffebd59d541acff37a1365))


### Documentation

* reference nais/grafana-apm-app[#86](https://github.com/nais/apm/issues/86) instead of the deleted multi-tenancy doc ([f6c3ac4](https://github.com/nais/apm/commit/f6c3ac4306f1a54af8d7f097381c20c809912d4d))

## 0.1.0 (2026-07-04)


### Features

* initial @nais/apm SDK — migrated from nais/grafana-otel-plugin ([1eccd64](https://github.com/nais/apm/commit/1eccd64afc4f82fd31cd0407b57b1f58c3e2e444))
* require team namespace, guard setUser PII, mark capture previews ([b86df68](https://github.com/nais/apm/commit/b86df68f16c2ce79071f424cdbb0b3cdd74d9117))


### Bug Fixes

* **replay:** scrub replay/snapshot payloads and Meta href for PII ([cda5eaf](https://github.com/nais/apm/commit/cda5eaf9e730f133a87a11378ac332563e3e3b9f))
* **test:** isolate config test from ambient GITHUB_SHA in CI ([c029195](https://github.com/nais/apm/commit/c02919551bb9952de4f251bc3f0dad9664d1e3b8))


### Documentation

* add RELEASING.md maintainer guide ([cb0aab2](https://github.com/nais/apm/commit/cb0aab2f796315ff60fa6a543ac64f8523d8633a))
* mark nav.no collector fallback as a nav-only assumption ([3ac33ae](https://github.com/nais/apm/commit/3ac33ae4b99ba6caad98d5c4c5233ace7712c249))
* **releasing:** explain the 0.1.0 first-release pin ([d3de592](https://github.com/nais/apm/commit/d3de592f77c31cca96df240fa14ac682dbdb2666))
* remove hand-written v0.1.0 changelog, move limitations to README ([4d57f1c](https://github.com/nais/apm/commit/4d57f1cd01cc8732f62fbd2aeb37cd948e5e2a23))


### Miscellaneous

* release initial version as 0.1.0 ([8f04320](https://github.com/nais/apm/commit/8f043209b999a3a99ac3303a7c49e0008c28dd47))

## Changelog

All notable changes to `@nais/apm` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project is pre-1.0 and does not yet strictly follow [Semantic Versioning](https://semver.org/) — breaking changes may land in `0.x` minor releases; each one will be called out here.

<!-- release-please manages entries below this line. -->
