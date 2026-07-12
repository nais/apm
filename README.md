# @nais/apm

A drop-in browser telemetry SDK for applications running on [nais](https://nais.io). `@nais/apm` wraps [`@grafana/faro-web-sdk`](https://github.com/grafana/faro-web-sdk) with a Sentry-like developer experience — zero-config initialization on nais, `captureException`/`captureMessage`/`setUser`-style APIs, mandatory PII scrubbing, a fixed console-capture bug, and opt-in session replay / crash snapshots — and ships everything to your team's self-hosted Grafana LGTM stack (Alloy `faro.receiver` → Loki/Tempo/Mimir) instead of a third-party SaaS.

> **Status: pre-1.0.** In active development and released continuously (see [Releases](https://github.com/nais/apm/releases) for the current version). The public API may still change before 1.0 — pin an exact version and expect breaking changes to land in minor releases until then. Feedback and issues are very welcome: [nais/apm/issues](https://github.com/nais/apm/issues).

## Install

`@nais/apm` is published to the **GitHub Package Registry** (GHPR) under the `nais` org, not to npmjs.org (yet).

GHPR requires an authenticated request to resolve _any_ package under a scope — including public ones — so even though `@nais/apm` itself is public, installing it needs a GitHub [Personal Access Token](https://github.com/settings/tokens) with the **`read:packages`** scope. This is a one-time setup per machine/CI job.

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
// main.tsx — the canonical call: two code-time constants, everything else resolved
import { init } from '@nais/apm';

init({ app: 'my-app', namespace: 'my-team' });
```

`app` and `namespace` are constants — identical in every environment — so passing
them in code is correct, not a compromise. What actually varies per deploy
(`environment`, the collector URL) is resolved at runtime; how depends on how your
app is served — see [Setup per serving architecture](#setup-per-serving-architecture).

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
  // Each field resolves independently if omitted (see below). `namespace` (the
  // owning nais team) is effectively required — telemetry without it can't be
  // attributed to a team; if it can't be resolved the SDK loud-warns and falls
  // back to `unknown-team` (it never throws).
  app: 'my-app',
  namespace: 'my-team',
  version: '2026.07.04-abc1234',
  environment: 'prod-gcp',
  telemetryUrl: undefined, // usually omitted — resolved automatically on nais

  beforeSend: (item) => item, // runs before the mandatory PII scrubber
  ignoreErrors: [/some noisy vendor error/],
  dangerouslyDisablePiiScrubbing: false, // see Privacy section — don't flip this without a reason
  faro: {}, // escape hatch: raw Faro BrowserConfig overrides

  sessionReplay: { enabled: false }, // see Session replay & crash snapshots
  screenshotOnError: false,
});
```

#### Configuration resolution

Each field (`app`, `namespace`, `version`, `environment`, `telemetryUrl`) resolves independently, highest priority first:

1. **Explicit `init()` options.**
2. **nais meta tags** in the served HTML:
   ```html
   <meta name="nais-app" content="my-app" />
   <meta name="nais-team" content="my-team" />
   <meta name="nais-cluster" content="prod-gcp" />
   <meta name="nais-version" content="2026.07.03-abc1234" />
   <meta name="nais-telemetry-url" content="https://telemetry.<tenant>.example/collect" />
   ```
   The tags are rendered by **your app's own server** — the platform does not inject
   them into HTML. Don't write them by hand: use `<NaisMetaTags />` /
   `getNaisMetaTags()` (see below), which read the pod's runtime env for you.
3. **Environment variables** — `NAIS_APP_NAME`, `NAIS_TEAM` (or `NAIS_NAMESPACE`), `NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL`, and a version derived from `GITHUB_SHA` or `NAIS_APP_IMAGE`'s tag. These are **pod-runtime** values (SSR); in a browser bundle they only exist if your bundler inlines `process.env.*` at build time — which is only ever correct for `version` (via `GITHUB_SHA`, which CI has). **Do not inline `NAIS_CLUSTER_NAME`**: the cluster is unknowable at build time — one image deploys to many clusters — so a baked-in value is wrong in at least one of them.
4. **Tenant fallback** — with no explicit/meta/env collector URL, the collector is derived from the cluster name (when known) or — on non-local hosts — from the page's hostname (`*.nav.no` → prod collector, `*.dev.nav.no` → dev collector). Built in for the nav tenant only, and explicitly interim: it is demoted once the platform serves config on a well-known URL. Other tenants pass their own `tenant` profile or rely on the platform channels; `tenant: false` disables derivation.
5. **Dev mode / loud failure** — if no collector URL resolves at all: on a genuinely local host (`localhost`, `127.0.0.1`, `*.local`) nothing is sent and everything echoes to the console (see [Local development](#local-development)); on **any other host this is a misconfiguration** and the SDK emits a specific `console.error` naming what's missing and how to fix it. It never throws.

Diagnose any resolution question with `init({ debug: true })` — it prints a per-field table of which source won.

The `namespace` (owning nais team) is special: the plugin groups and attributes all telemetry by team, so browser telemetry without it can't be reliably attributed. It resolves via the same precedence (`init({ namespace })` → `nais-team`/`nais-namespace` meta → `NAIS_TEAM`/`NAIS_NAMESPACE` env) and is wired to Faro's `app.namespace`, which the collector emits as the `app_namespace` log field. If it can't be resolved the SDK does **not** throw (that would take down your app) — it loud-warns (`console.error` on real hosts, `console.warn` in local dev) and falls back to `unknown-team`.

#### Setup per serving architecture

The nais platform provides frontend config through `spec.frontend.generatedConfig`
([nais docs](https://docs.nais.io/observability/frontend/)): naiserator mounts a
`nais.js` module (collector URL, app name/namespace/version, environment) into the
pod and sets `NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL`. Pick the consumption path that
matches how your app serves HTML:

**SSR (Next.js & friends)** — render the meta tags server-side from the pod env; the
browser-side `init()` picks them up:

```tsx
// app/layout.tsx (App Router) or _document.tsx <Head> (Pages Router)
import { NaisMetaTags } from '@nais/apm/react';

<head>
  <NaisMetaTags />
</head>

// instrumentation-client.ts
import { initNaisAPMClient } from '@nais/apm/react';
initNaisAPMClient({ app: 'my-app', namespace: 'my-team' });
```

Non-React SSR: `renderNaisMetaTags()` returns the same tags as an HTML string, and
`getNaisMetaTags()` as data. Servers that import the mounted module directly can pass
it through instead: `init(fromNaisConfig((await import('/app/nais.js')).default))`.

**Static SPA served from a pod (nginx/Node)** — point `generatedConfig.mountPath` into
your web root so the file is served, then fetch-and-init:

```yaml
# nais.yaml
spec:
  frontend:
    generatedConfig:
      mountPath: /usr/share/nginx/html/nais.js
```

naiserator mounts `nais.json` (same payload, JSON) next to the `nais.js` module
(nais/naiserator#687), so both are served from the web root.

```ts
import { initFromConfigUrl } from '@nais/apm';

// Fetches the served config, then initializes. Errors thrown while the fetch
// is in flight are buffered and sent after init — nothing is lost. If the
// fetch fails, init proceeds with the standard resolution chain (loudly).
void initFromConfigUrl('/nais.json', { app: 'my-app', namespace: 'my-team' });
```

Prefer the ESM module instead? Import it natively (keep it out of the bundle with
your bundler's ignore comment) and pass it through:

```ts
import { init, fromNaisConfig } from '@nais/apm';

const cfg = await import(/* @vite-ignore */ /* webpackIgnore: true */ '/nais.js');
init({ ...fromNaisConfig(cfg.default), namespace: 'my-team' });
```

**CDN-served (no pod serves your HTML)** — there is no runtime injection point, so
pass what you know in code and let `version` come from CI:

```ts
init({
  app: 'my-app',
  namespace: 'my-team',
  // version: inlined from GITHUB_SHA by your bundler (safe — CI knows the SHA)
});
```

On nav domains this works as-is: the collector is derived from the page's hostname
(the interim tenant fallback above). Off nav domains, pass `telemetryUrl` explicitly
until the platform serves config on a well-known URL.

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

NAV operates on **identities**, not emails — and identities are PII that must **not** reach the shared Loki instance (every team shares it). Pass only an **opaque, non-identifying** correlation key: a salted hash of the identity, never a raw NAV ident, fødselsnummer, email, or name.

```ts
import { setUser, clearUser } from '@nais/apm';

setUser({ id: hashedSubject }); // hashedSubject = a salted hash, NOT an ident/fnr/email
// ... on logout:
clearUser();
```

As a safety net, `setUser` defensively drops any `id`/`username`/`attributes` value that looks like PII (fødselsnummer, email, or a raw NAV ident) and warns once; the `email` field is **deprecated** and dropped unconditionally.

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

### `pushMeasurement(type, values, options?)` / `pushEvent(name, attributes?, domain?)`

Safe, documented entry points for **custom telemetry** — a thin wrapper over Faro's `pushMeasurement`/`pushEvent` so you don't have to reach for the raw `faro` instance. Both ride the same guarded transport as everything else, so the mandatory PII scrubbing (below) — including **NAV-ident redaction** on the string labels — runs on the way out.

```ts
import { pushMeasurement, pushEvent } from '@nais/apm';

// A numeric metric. `values` are numbers (the metric itself, never scrubbed).
pushMeasurement('checkout_latency', { ms: 812 }, { context: { page: 'oversikt' } });

// A structured event with string attributes.
pushEvent('feature_flag_evaluated', { flag: 'new-checkout', value: 'on' });
```

Do **not** put identities (NAV idents, fødselsnummer, emails, names) in the `context`/`attributes` labels — those are string fields that land on the **shared** Loki instance. Ident-shaped values (`Z994455`), fnr, email, and token params are scrubbed automatically, but names are not pattern-shaped and will not be caught.

### `captureFeedback(message, options?)`

Free-text user feedback capture — no direct Sentry equivalent, this is `@nais/apm`'s own addition. Feedback is joined to the current session automatically, and optionally to a specific issue via `fingerprint`.

> **Preview — internal-pilot only, not GA.** The free-text `message` lands in the shared Loki instance, so any UI you wire to this **must** show a clear "do not enter personal information" warning next to the input, and — like session replay — it is gated on the personvernombud process for citizen-facing use.

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

Every outgoing signal (exception values, stack traces, log lines, context values, custom measurement/event labels, and the page URL) passes through a `beforeSend` scrubbing pipeline before it leaves the browser:

- **Norwegian fødselsnummer** (11 digits, sanity-checked against a plausible date prefix, including D-numbers, H-numbers, and synthetic test numbers) → `[fnr]`
- **Email addresses** → `[email]`
- **Token-bearing URL parameters** (`token`, `access_token`, `id_token`, `refresh_token`, `code`, `state`) → `[redacted]`
- **Raw NAV idents** (a letter + six digits, e.g. `Z994455`) in custom measurement `context` and event `attributes` → `[ident]`. Whole-value match only, so ordinary low-cardinality labels are left alone; numeric measurement `values` are the metric and are never touched. Names (e.g. an `enhetNavn`) are not pattern-shaped and are **not** caught — don't put them in labels.

Your own `init({ beforeSend })` hook (if any) runs **first** and may drop items by returning `null`; the scrubber always runs **last**, so it also sees anything your hook added.

Opt-out requires an explicit `init({ dangerouslyDisablePiiScrubbing: true })`. If you do that, your team owns the GDPR consequences of everything the app sends to Loki. Scrubbing is regex-based and best-effort — it is a safety net, **not** a GDPR guarantee. Do not put personal data in error messages in the first place.

## Session replay & crash snapshots (preview — opt-in, not GA)

> **Preview, not GA.** `sessionReplay` and `screenshotOnError` (like `captureFeedback`) push DOM/snapshot/free-text data that lands in the **shared** Loki instance — they can carry user content into a shared log store. They are **internal-apps-first** and gated on NAV's **personvernombud** (data protection officer) process. Do **not** enable them on citizen-facing apps without sign-off. The masking floor below is a safety net, not a substitute for that assessment.

Two related, disabled-by-default features let a team see what a user did around an error:

- **`sessionReplay`** — captures a session timeline. It has two independent knobs:
  - **`tier`** — _what_ is captured (the privacy tier):
    - `'events'` **(default)** — a lightweight **interaction timeline** derived from DOM events: navigation, clicks, rage-clicks, and coarse scroll, carrying only element **tag/role**, click **coordinates**, and **timestamps**. There is **no DOM node tree and no `rrweb` capture at all** on this path — structurally nothing to leak beyond URLs (which are scrubbed). This tier is safe by construction and does not pull `rrweb` into your bundle.
    - `'wireframe'` — reserved (planned); currently falls back to `'events'`.
    - `'dom'` — the full **masked DOM recording** (via `rrweb`). This is the pre-existing behavior and pushes DOM data into shared Loki, so it is the one tier gated on the personvernombud process.
  - **`mode`** — _when_ the timeline is shipped (the capture trigger, unchanged): `'on-error'` (default) buffers in memory and ships only once an error occurs; `'always'` streams continuously, gated by `sampleRate`.
- **`screenshotOnError`** — folded into the tier model: with `tier: 'dom'` it captures one masked DOM snapshot per new error (throttled, capped per session); otherwise it degrades to a text-free **events-tier breadcrumb** (URL + viewport, no node tree). Adds nothing when a session-replay collector/recorder is already active for the session.

> **Preview default change.** `sessionReplay: { enabled: true }` with no `tier` now resolves to the **`events`** tier (no DOM). Previously it produced the masked DOM recording. Pass `tier: 'dom'` to keep DOM capture. A one-time `console.warn` flags this.

```ts
// Safe default: DOM-free interaction timeline.
init({
  sessionReplay: {
    enabled: true,
    mode: 'on-error', // or 'always'
    sampleRate: 0.5, // fraction of sessions recorded, 0..1
  },
});

// Full masked DOM recording (personvernombud-gated).
init({
  sessionReplay: {
    enabled: true,
    tier: 'dom',
    block: ['.no-record-me'], // extra CSS selectors to block; tighten-only
  },
});
```

**These features are opt-in for a reason: a team must decide, deliberately, to turn on screen recording for its own users.** This is not a technical toggle to flip lightly — it reflects NAV's personvernombud (data protection officer) process, and each team is responsible for making that call for its own application and users, in line with its own privacy assessment.

The events tier avoids this exposure by construction — it never serializes the DOM, so there is no text/input/node content to mask. The masking floor below applies to the **DOM tier** (`tier: 'dom'` and the `tier: 'dom'` `screenshotOnError` snapshot), and is a **non-overridable** floor applied in the browser before any byte leaves the user's machine:

- every form input value is masked, with no exceptions — inputs can never be unmasked, not even via the allowlist below;
- all text is masked, except elements explicitly marked with a `data-apm-unmask` attribute;
- images, video, audio, canvas, iframes, embeds, and anything marked `data-apm-block` are always blocked, never inlined;
- stylesheets and images are never inlined into the capture.

The `block` option can only add more selectors to block — there is no option to relax any part of the masking floor.

## Local development

On a genuinely local host (`localhost`, `127.0.0.1`, `*.local`, `*.localhost`) with no collector URL resolved, `init()`:

- warns once: `[@nais/apm] No telemetry collector URL resolved …`,
- sends **nothing** over the network,
- echoes every signal to the browser console instead, so you can see exactly what would have been sent.

Calling `captureException`/`captureMessage`/`setUser`/etc. before `init()` is a safe no-op (with a single warning).

## Escape hatch

`init({ faro: { ... } })` accepts raw Faro `BrowserConfig` overrides for anything this package doesn't expose directly. `beforeSend` is the one exception — it stays composed with the mandatory PII scrubber rather than being fully overridden.

## Browser tracing

Opt in with `init({ tracing: true })`. This lazily loads `@grafana/faro-web-tracing` (kept out of your bundle unless you enable it) and starts propagating W3C trace-context headers so browser spans join their backend traces in Tempo.

```ts
init({ tracing: true });
```

Trace headers are only ever sent to **nais-owned backends**: a non-overridable floor restricts propagation to the app's own origin and any `https://*.nav.no` host. You can add more origins, but you can never remove the floor (and it is not reachable through the `faro` escape hatch):

```ts
init({ tracing: { propagateExtraOrigins: ['https://api.partner.example'] } });
```

## React — `@nais/apm/react`

A separate entry point with React helpers. React and `react-router` are optional peer dependencies; importing this entry requires them (plus `@grafana/faro-react` for the React Router v6 wiring). The root `@nais/apm` entry stays free of React and OpenTelemetry.

**Error boundary** — catches render errors and reports them once through `captureException` (so they get the SDK's fingerprint/context pipeline):

```tsx
import { ApmErrorBoundary } from '@nais/apm/react';

<ApmErrorBoundary fingerprint="checkout" fallback={<p>Something went wrong.</p>}>
  <Checkout />
</ApmErrorBoundary>;
```

There is also a `withApmErrorBoundary(Component, props?)` HOC.

**Route tracking (React Router v6)** — call once after `init()`, passing your own react-router-dom exports, then render `<ApmRoutes>` in place of `<Routes>`:

```tsx
import { createRoutesFromChildren, matchRoutes, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { enableApmReactRouterV6, ApmRoutes } from '@nais/apm/react';

enableApmReactRouterV6({ createRoutesFromChildren, matchRoutes, Routes, useLocation, useNavigationType });
```

**Route tracking (Next.js App Router)** — use the `useApmRouteTracking` hook in a client component:

```tsx
'use client';
import { usePathname, useSearchParams } from 'next/navigation';
import { useApmRouteTracking } from '@nais/apm/react';

export function ApmRouteTracker() {
  useApmRouteTracking(usePathname(), useSearchParams());
  return null;
}
```

**Next.js client init** — `initNaisAPMClient` is the entry for Next 15+ `instrumentation-client.ts` (and the Pages Router `_app.tsx`). It no-ops on the server and is idempotent under StrictMode:

```ts
// instrumentation-client.ts
import { initNaisAPMClient } from '@nais/apm/react';
initNaisAPMClient({ namespace: 'my-team', tracing: true });
```

React Router v5/v7 and the data-router variants are follow-ups.

## Versioning & stability

This package follows semver, but is **pre-1.0**: expect the public API to keep moving (new options, renamed fields, new exports like tracing and React helpers) across `0.x` minor releases. Pin an exact version in your `package.json` and read the [CHANGELOG](./CHANGELOG.md) before upgrading. Breaking changes will be called out there.

## Not yet supported

Planned for later `0.x` releases:

- **React Router v5/v7 & data routers** — route tracking currently covers React Router v6 and the Next.js App Router.
- **Registry** — published to GitHub Package Registry only; a move to npmjs.org (dropping the `read:packages` token requirement for installs) is under consideration.

## Development

```sh
pnpm install
pnpm test        # vitest (jsdom)
pnpm build       # tsc -> dist/
```

## License

[MIT](./LICENSE)
