# Changelog

All notable changes to `@nais/apm` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project is pre-1.0 and does not yet strictly follow [Semantic Versioning](https://semver.org/) — breaking changes may land in `0.x` minor releases; each one will be called out here.

## [0.1.0] — 2026-07-04

First published version. Migrated out of the `nais/grafana-otel-plugin` monorepo (`sdk/`) into its own repository, `nais/apm`, for external testing.

### Added

- `init(options?)` — zero-config initialization on nais: app name, version, environment, and Faro collector URL resolved from `init()` options, nais meta tags (`nais-app`, `nais-cluster`, `nais-version`, `nais-telemetry-url`), or build-time `NAIS_*` / `GITHUB_SHA` environment variables, in that priority order.
- Sentry-compatible API: `captureException`, `captureMessage`, `setUser`, `clearUser`, `setTag`, `setContext`.
- `captureFeedback` — free-text user feedback capture, joined to the current session and optionally to an issue via `fingerprint`. `@nais/apm`'s own addition; no direct Sentry equivalent.
- Mandatory PII scrubbing `beforeSend` pipeline: Norwegian fødselsnummer (with D-/H-number and synthetic-test-number handling), email addresses, and token-bearing URL parameters are redacted from every outgoing signal. Composable with a user-supplied `beforeSend`; opt-out only via explicit `dangerouslyDisablePiiScrubbing: true`.
- `NaisConsoleInstrumentation` — replaces Faro's own console capture so `console.error('message', err)` is captured with the error's original stack trace, fixing a case Faro's default instrumentation mishandles.
- Session replay (`sessionReplay`, opt-in, `rrweb`-based, `on-error` or `always` mode, deterministic per-session sampling) and crash snapshots (`screenshotOnError`, opt-in, throttled masked DOM capture on error), both lazy-loaded and both built on a non-overridable masking floor (all inputs masked with no exceptions; all text masked except an explicit `data-apm-unmask` allowlist; media/canvas/iframes always blocked).
- Local-dev behavior: when no telemetry collector URL resolves (e.g. `localhost`), nothing is sent over the network — every signal is echoed to the browser console instead, with a single one-time warning.
- `isInitialized()` and `scrubString()` as supporting exports.
- 79 vitest tests covering config resolution, PII scrubbing, console capture, the Sentry-compat API, feedback, and session replay/snapshot masking.

### Known limitations (tracked for post-0.1.0)

- No tracing support yet (`@grafana/faro-web-tracing` integration planned).
- No `@nais/apm/react` entry point yet (e.g. an `ErrorBoundary` helper); planned for a later release.
- Published to GitHub Package Registry only; a move to npmjs.org to remove the `read:packages` PAT requirement for installs is under consideration.
