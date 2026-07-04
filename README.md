# @nais/apm

A drop-in browser telemetry SDK for applications running on [nais](https://nais.io). `@nais/apm` wraps [`@grafana/faro-web-sdk`](https://github.com/grafana/faro-web-sdk) with a Sentry-like developer experience — zero-config initialization on nais, `captureException`/`captureMessage`/`setUser`-style APIs, mandatory PII scrubbing, a fixed console-capture bug, and opt-in session replay / crash snapshots — and ships everything to your team's self-hosted Grafana LGTM stack (Alloy `faro.receiver` → Loki/Tempo/Mimir) instead of a third-party SaaS.

> **Status: 0.1.0, pre-release.** This is the first published version, intended for early external testing. The public API may still change before 1.0 — pin an exact version and expect breaking changes to land in minor releases until then. Feedback and issues are very welcome: [nais/apm/issues](https://github.com/nais/apm/issues).

## Install

`@nais/apm` is published to the **GitHub Package Registry** (GHPR) under the `nais` org, not to npmjs.org (yet).

GHPR requires an authenticated request to resolve *any* package under a scope — including public ones — so even though `@nais/apm` itself is public, installing it needs a GitHub [Personal Access Token](https://github.com/settings/tokens) with the **`read:packages`** scope. This is a one-time setup per machine/CI job.

1. Create a classic PAT with the `read:packages` scope (fine-grained tokens work too, as long as they can read packages for the `nais` org).
2. Add these two lines to your project's `.npmrc` (create the file if it doesn't exist):

   ```ini
   @nais:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
   ```

3. Export the token in your shell (or CI secret store) as `GITHUB_PACKAGES_TOKEN`:

   ```sh
   export GITHUB_PACKAGES_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

4. Install:

   ```sh
   pnpm add @nais/apm
   # or: npm install @nais/apm / yarn add @nais/apm
   ```

> This friction is a GHPR limitation, not a `@nais/apm` design choice. A future move to npmjs.org (`npmjs.com/package/@nais/apm`) would let anyone `npm install @nais/apm` with no token at all — it's on the roadmap once the package is stable.

## Quickstart

```ts
// main.tsx — the whole zero-config story
import { init } from '@nais/apm';

init(); // app name, version, environment and collector URL resolved from nais
```

```ts
// Sentry-style usage anywhere in your app
import { captureException, captureMessage, setUser, setContext } from '@nais/apm';

try {
  await save(form);
} catch (e) {
  captureException(e, { context: { form: 'checkout-step-2' } });
}

captureMessage('fallback flow used', 'warning');
setUser({ id: hashedSubject });
setContext('feature', { newCheckoutFlow: 'variant-b' });
```

That's it on nais: `init()` resolves app name, version, environment, and the collector URL automatically (see [Configuration resolution](#configuration-resolution) below). Off nais — e.g. on `localhost` — nothing is sent over the network; every signal is echoed to the browser console instead (see [Local development](#local-development)).

## API reference

### `init(options?)`

Initializes the SDK. Safe to call once; a second call warns and returns the existing instance.

```ts
import { init } from '@nais/apm';

init({
  // All fields optional — each resolves independently if omitted (see below).
  app: 'my-app',
  version: '2026.07.04-abc1234',
  environment: 'prod-gcp',
  telemetryUrl: 'https://telemetry.nav.no/collect',

  beforeSend: (item) => item, // runs before the mandatory PII scrubber
  ignoreErrors: [/some noisy vendor error/],
  dangerouslyDisablePiiScrubbing: false, // see Privacy section — don't flip this without a reason
  faro: {}, // escape hatch: raw Faro BrowserConfig overrides

  sessionReplay: { enabled: false }, // see Session replay & crash snapshots
  screenshotOnError: false,
});
```

#### Configuration resolution

Each field (`app`, `version`, `environment`, `telemetryUrl`) resolves independently, highest priority first:

1. **Explicit `init()` options.**
2. **nais meta tags** in the served HTML:
   ```html
   <meta name="nais-app" content="my-app">
   <meta name="nais-cluster" content="prod-gcp">
   <meta name="nais-version" content="2026.07.03-abc1234">
   <meta name="nais-telemetry-url" content="https://telemetry.nav.no/collect">
   ```
3. **Build-time environment variables** — `NAIS_APP_NAME`, `NAIS_CLUSTER_NAME`, and a version derived from `NAIS_APP_IMAGE`'s tag (or `GITHUB_SHA` if set). These only work when your bundler inlines `process.env.*` (webpack `DefinePlugin`, Vite `define`, Next.js `env`).
4. **Collector fallback** — with no explicit/meta collector URL, well-known nais collectors are derived from the cluster name (`prod-*` → `https://telemetry.nav.no/collect`, `dev-*` → `https://telemetry.ekstern.dev.nav.no/collect`).
5. **Dev mode** — if no collector URL resolves at all (typically localhost), nothing is sent; see [Local development](#local-development).

### `captureException(error, options?)`

Sentry-compatible exception capture. Note: unlike Sentry, no event ID is returned (a Faro limitation).

```ts
import { captureException } from '@nais/apm';

try {
  risky();
} catch (e) {
  captureException(e, {
    context: { orderId: '123' },
    fingerprint: 'checkout-timeout', // custom grouping key
  });
}
```

### `captureMessage(message, level?)`

```ts
import { captureMessage } from '@nais/apm';

captureMessage('fallback flow used', 'warning'); // 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'
```

### `setUser(user)` / `clearUser()`

```ts
import { setUser, clearUser } from '@nais/apm';

setUser({ id: hashedSubject, email: 'user@example.com', username: 'jdoe' });
// ... on logout:
clearUser();
```

### `setTag(key, value)`

Approximation of `Sentry.setTag` — Faro has no first-class tag/label concept, so the value rides along as context on every subsequent capture rather than as an indexed label.

```ts
import { setTag } from '@nais/apm';

setTag('featureFlag.newCheckout', true);
```

### `setContext(name, context)`

Attaches named context, flattened as `name.key`, to every subsequent capture. Pass `null` to remove a previously set context.

```ts
import { setContext } from '@nais/apm';

setContext('order', { id: '123', total: 499 });
setContext('order', null); // remove it
```

### `captureFeedback(message, options?)`

Free-text user feedback capture — no direct Sentry equivalent, this is `@nais/apm`'s own addition. Feedback is joined to the current session automatically, and optionally to a specific issue via `fingerprint`.

```ts
import { captureFeedback } from '@nais/apm';

captureFeedback('The export button did nothing', {
  category: 'bug', // 'bug' | 'idea' | 'other', default 'other'
  email: 'user@example.com', // optional, only sent if it looks like a real email
  fingerprint: 'export-button-noop',
  context: { page: 'reports' },
});
```

### `isInitialized()`

```ts
import { isInitialized } from '@nais/apm';

if (!isInitialized()) {
  init();
}
```

### `scrubString(value)`

Exposes the PII scrubber directly, e.g. if you want to sanitize a string before logging it yourself.

```ts
import { scrubString } from '@nais/apm';

console.log(scrubString('contact me at user@example.com'));
// -> "contact me at [email]"
```

## Privacy: PII scrubbing (mandatory)

Every outgoing signal (exception values, stack traces, log lines, context values, and the page URL) passes through a `beforeSend` scrubbing pipeline before it leaves the browser:

- **Norwegian fødselsnummer** (11 digits, sanity-checked against a plausible date prefix, including D-numbers, H-numbers, and synthetic test numbers) → `[fnr]`
- **Email addresses** → `[email]`
- **Token-bearing URL parameters** (`token`, `access_token`, `id_token`, `refresh_token`, `code`, `state`) → `[redacted]`

Your own `init({ beforeSend })` hook (if any) runs **first** and may drop items by returning `null`; the scrubber always runs **last**, so it also sees anything your hook added.

Opt-out requires an explicit `init({ dangerouslyDisablePiiScrubbing: true })`. If you do that, your team owns the GDPR consequences of everything the app sends to Loki. Scrubbing is regex-based and best-effort — it is a safety net, **not** a GDPR guarantee. Do not put personal data in error messages in the first place.

## Session replay & crash snapshots (opt-in)

Two related, disabled-by-default features let a team see what a user's screen looked like around an error:

- **`sessionReplay`** — records the session (via `rrweb`) and, in the default `on-error` mode, only ships the last ~60–120 seconds once an error actually occurs (nothing leaves the browser before that). `mode: 'always'` streams continuously instead, gated by `sampleRate`.
- **`screenshotOnError`** — captures one masked DOM snapshot per new error (throttled, capped per session), without recording a full session. Automatically disabled when `sessionReplay` is on, since a recording's checkout already contains the same information.

```ts
init({
  sessionReplay: {
    enabled: true,
    mode: 'on-error', // or 'always'
    sampleRate: 0.5, // fraction of sessions recorded, 0..1
    block: ['.no-record-me'], // extra CSS selectors to block; tighten-only
  },
});
```

**These features are opt-in for a reason: a team must decide, deliberately, to turn on screen recording for its own users.** This is not a technical toggle to flip lightly — it reflects NAV's personvernombud (data protection officer) process, and each team is responsible for making that call for its own application and users, in line with its own privacy assessment.

To make that decision safer regardless of which way it goes, both features share a **non-overridable masking floor**, applied in the browser before any byte leaves the user's machine:

- every form input value is masked, with no exceptions — inputs can never be unmasked, not even via the allowlist below;
- all text is masked, except elements explicitly marked with a `data-apm-unmask` attribute;
- images, video, audio, canvas, iframes, embeds, and anything marked `data-apm-block` are always blocked, never inlined;
- stylesheets and images are never inlined into the capture.

The `block` option can only add more selectors to block — there is no option to relax any part of the masking floor.

## Local development

On `localhost` (or anywhere no collector URL resolves), `init()`:

- warns once: `[@nais/apm] No telemetry collector URL resolved …`,
- sends **nothing** over the network,
- echoes every signal to the browser console instead, so you can see exactly what would have been sent.

Calling `captureException`/`captureMessage`/`setUser`/etc. before `init()` is a safe no-op (with a single warning).

## Escape hatch

`init({ faro: { ... } })` accepts raw Faro `BrowserConfig` overrides for anything this package doesn't expose directly. `beforeSend` is the one exception — it stays composed with the mandatory PII scrubber rather than being fully overridden.

## Versioning & stability

This package follows semver, but is **pre-1.0**: expect the public API to keep moving (new options, renamed fields, new exports like tracing and React helpers) across `0.x` minor releases. Pin an exact version in your `package.json` and read the [CHANGELOG](./CHANGELOG.md) before upgrading. Breaking changes will be called out there.

## Development

```sh
pnpm install
pnpm test        # vitest (jsdom)
pnpm build       # tsc -> dist/
```

## License

[MIT](./LICENSE)
