/**
 * @nais/apm — opinionated Faro wrapper with a Sentry-like DX for nais apps.
 *
 * Root surface: `init`, `captureException`, `captureMessage`, `setUser`,
 * `clearUser`, `setTag`, `setContext`, and opt-in browser tracing
 * (`init({ tracing: true })`, lazily loaded). React helpers live in the
 * separate `@nais/apm/react` entry point so this root stays free of React and
 * the OpenTelemetry tracing tree.
 */

import {
  ConsoleTransport,
  getWebInstrumentations,
  initializeFaro,
} from '@grafana/faro-web-sdk';
import type { BeforeSendHook, BrowserConfig, Faro, Patterns } from '@grafana/faro-web-sdk';

import { resolveConfig } from './config.js';
import type { ConfigOptions } from './config.js';
import { NaisConsoleInstrumentation } from './console.js';
import { getStoredFaro, setFaroInstance } from './internal.js';
import { normalizeSessionReplay } from './replay/options.js';
import { composeBeforeSend } from './scrub.js';

export { captureException, captureMessage, setUser, clearUser, setTag, setContext } from './api.js';
export type { CaptureExceptionOptions, SeverityLevel, User } from './api.js';
export { captureFeedback, FEEDBACK_EVENT_NAME } from './feedback.js';
export type { CaptureFeedbackOptions, FeedbackCategory } from './feedback.js';
export { resolveConfig, versionFromImage } from './config.js';
export type { ConfigOptions, ResolvedConfig } from './config.js';
export { NaisConsoleInstrumentation, CONSOLE_ERROR_PREFIX } from './console.js';
export { scrubString } from './scrub.js';
export { isInitialized } from './internal.js';
export { VERSION } from './version.js';

/**
 * Default noise filters: browser-extension frames, benign ResizeObserver
 * loops, and cross-origin "Script error." events without information.
 */
export const DEFAULT_IGNORE_ERRORS: Patterns = [
  'chrome-extension://',
  'moz-extension://',
  'safari-extension://',
  'safari-web-extension://',
  /ResizeObserver loop (limit exceeded|completed with undelivered notifications)/,
  /^Script error\.?$/,
];

export interface InitOptions extends ConfigOptions {
  /**
   * Runs before the mandatory PII scrubber. Return `null` to drop the item.
   * The scrubber always runs last.
   */
  beforeSend?: BeforeSendHook;
  /** Extra patterns appended to {@link DEFAULT_IGNORE_ERRORS}. */
  ignoreErrors?: Patterns;
  /**
   * Disable the built-in PII scrubbing (fødselsnummer, emails, token URLs).
   * You almost certainly do not want this; you take over GDPR responsibility
   * for everything your app sends to Loki.
   */
  dangerouslyDisablePiiScrubbing?: boolean;
  /**
   * Escape hatch: raw Faro `BrowserConfig` overrides merged last (except
   * `beforeSend`, which stays composed with the scrubber). Prefer the
   * top-level options.
   */
  faro?: Partial<BrowserConfig>;
  /**
   * PREVIEW — NOT GA. Opt-in, internal-apps-first. Session replay
   * (nais/grafana-apm-app#58, #82). Off by default.
   *
   * Two independent knobs:
   *
   *   - `tier` — the PRIVACY TIER, i.e. WHAT is captured:
   *       - `'events'` (default): a lightweight interaction timeline derived
   *         from DOM events — NO DOM node tree, structurally nothing to leak
   *         beyond (already-scrubbed) URLs. Safe by construction.
   *       - `'wireframe'`: reserved (Phase 3 — currently falls back to events).
   *       - `'dom'`: the full masked DOM recording (rrweb). Pushes DOM data into
   *         shared Loki, so it is gated on the personvernombud (data protection
   *         officer) process — do NOT enable on citizen-facing apps without
   *         sign-off. Masked at capture time by a non-overridable privacy floor
   *         (all text and inputs; unmasking only via explicit `data-apm-unmask`
   *         markup); `block` can only tighten masking.
   *
   *   - `mode` — the CAPTURE TRIGGER, i.e. WHEN the timeline is shipped
   *     (unchanged): `'on-error'` (default) buffers in memory and sends only
   *     once an error occurs; `'always'` streams continuously.
   *
   * BREAKING (preview): `enabled:true` with `tier` omitted now resolves to
   * `'events'`, not the old masked-DOM capture. Pass `tier:'dom'` to keep DOM.
   */
  sessionReplay?: {
    enabled?: boolean;
    /** Privacy tier — WHAT is captured. Default `'events'` (no DOM). */
    tier?: 'events' | 'wireframe' | 'dom';
    /** Capture trigger — WHEN the timeline ships. 'on-error' (default) or 'always'. */
    mode?: 'on-error' | 'always';
    /** Fraction of sessions recorded, 0..1 (default 1). */
    sampleRate?: number;
    /** Extra CSS selectors to block entirely (tighten-only; DOM tier). */
    block?: string[];
  };
  /**
   * PREVIEW — NOT GA. Opt-in. Capture something on the FIRST error, folded into
   * the `sessionReplay.tier` model (nais/grafana-apm-app#67, #82):
   *   - with `sessionReplay.tier:'dom'` (and no full recording running): one
   *     masked DOM snapshot per new error (throttled, capped, personvernombud-
   *     gated — it lands in shared Loki and can carry user content);
   *   - otherwise (the events-tier default): a text-free events-tier breadcrumb
   *     (URL + viewport, NO node tree) — no DOM leaves the browser.
   * Adds nothing when a session-replay collector/recorder is already active for
   * the session (that path already captures the error).
   */
  screenshotOnError?: boolean;
  /**
   * Opt-in browser tracing (nais/grafana-apm-app#80). Off by default. When
   * enabled, `@grafana/faro-web-tracing` is lazily loaded (kept out of the
   * bundle otherwise) and distributed-trace headers are propagated so browser
   * spans join backend traces in Tempo.
   *
   * `true` enables tracing with the mandatory propagation floor (same-origin +
   * `*.nav.no` only). Pass an object with `propagateExtraOrigins` to ALSO
   * propagate trace headers to additional origins — these are appended to the
   * floor and can never replace or empty it (a security restriction: trace
   * headers must not leak to arbitrary third parties). The floor is not
   * reachable through the `faro` escape hatch.
   */
  tracing?: boolean | { propagateExtraOrigins?: (string | RegExp)[] };
}

/**
 * Initialize @nais/apm. Zero-config on nais: app name, version, environment
 * and collector URL are resolved from nais meta tags or build-time env; with
 * no collector resolved (local dev) all telemetry is echoed to the console.
 *
 * Opt into distributed tracing with `init({ tracing: true })`; the tracing
 * machinery (`@grafana/faro-web-tracing`) is lazily loaded so it stays out of
 * the bundle when tracing is not enabled.
 */
export function init(options: InitOptions = {}): Faro {
  const existing = getStoredFaro();
  if (existing) {
    // eslint-disable-next-line no-console
    console.warn('[@nais/apm] init() called more than once; returning the existing instance.');
    return existing;
  }

  const config = resolveConfig(options);

  const browserConfig: BrowserConfig = {
    app: {
      name: config.app,
      // The nais team that owns this app. Faro's app model carries `namespace`,
      // and the Alloy `faro.receiver` emits it as the `app_namespace` field on
      // every log line — the label the plugin uses to attribute/filter browser
      // telemetry by team (mirrors span metrics' `service_namespace`).
      namespace: config.namespace,
      version: config.version,
      environment: config.environment,
      // `release` mirrors `version` so exception grouping and release tagging
      // in the Nais APM plugin line up with the deployed image.
      release: config.version,
    },
    instrumentations: [
      // captureConsole MUST stay false: NaisConsoleInstrumentation is the only
      // console patch (see nais/grafana-apm-app#66).
      ...getWebInstrumentations({ captureConsole: false }),
      new NaisConsoleInstrumentation(),
    ],
    ignoreErrors: [...DEFAULT_IGNORE_ERRORS, ...(options.ignoreErrors ?? [])],
    ...(config.devMode
      ? { transports: [new ConsoleTransport()] }
      : { url: config.telemetryUrl }),
    ...options.faro,
    beforeSend: composeBeforeSend(
      options.beforeSend ?? options.faro?.beforeSend,
      options.dangerouslyDisablePiiScrubbing === true
    ),
  };

  // Replay/snapshot error trigger: the composed beforeSend sees every
  // exception item regardless of capture path (uncaught, unhandledrejection,
  // captureException, console capture) — one choke point. Multiple capture
  // paths (events timeline, DOM recording, screenshot) may register a handler;
  // each is invoked once per captured error.
  const errorHandlers: Array<(message: string) => void> = [];
  const composed = browserConfig.beforeSend!;
  browserConfig.beforeSend = (item) => {
    const result = composed(item);
    if (result && errorHandlers.length > 0 && (item as { type?: string }).type === 'exception') {
      const payload = (item as { payload?: { value?: unknown } }).payload;
      const message = String(payload?.value ?? '');
      for (const handler of errorHandlers) {
        handler(message);
      }
    }
    return result;
  };

  const faro = initializeFaro(browserConfig);
  setFaroInstance(faro);

  // Opt-in browser tracing. Lazily imported (like replay) so faro-web-tracing
  // and its OpenTelemetry dependency tree stay out of the bundle of apps that
  // do not enable tracing. The mandatory header-propagation floor lives in
  // tracing.ts and cannot be overridden here.
  if (options.tracing) {
    const tracingOptions =
      typeof options.tracing === 'object' ? options.tracing : undefined;
    void import('./tracing.js')
      .then(({ startTracing }) =>
        startTracing(faro, {
          propagateExtraOrigins: tracingOptions?.propagateExtraOrigins,
        })
      )
      .catch(() => {});
  }

  // Session-replay tier switch. `normalizeSessionReplay` applies the safe
  // default tier (`events`), validates the enum, and warns the pilots affected
  // by the masked-DOM → events default change.
  const replay = normalizeSessionReplay(options.sessionReplay);
  const wantScreenshot = options.screenshotOnError === true;
  if (replay.enabled || wantScreenshot) {
    const push = (name: string, attributes: Record<string, string>): void => {
      faro.api.pushEvent(name, attributes);
    };
    const sessionId = faro.api.getSession?.()?.id;

    if (replay.enabled) {
      if (replay.tier === 'dom') {
        // Full masked DOM recording (rrweb) — personvernombud-gated.
        void import('./replay/recording.js')
          .then(({ startRecording }) =>
            startRecording({
              mode: replay.mode,
              sampleRate: replay.sampleRate,
              block: replay.block,
              push,
              sessionId,
            })
          )
          .then((handle) => {
            if (handle) {
              errorHandlers.push(() => handle.notifyError());
            }
          })
          .catch(() => {});
      } else {
        // events (default) and wireframe (Phase 3, currently falls back here):
        // a DOM-free interaction timeline; no rrweb on this path.
        void import('./replay/events.js')
          .then(({ startEventsCollection }) =>
            startEventsCollection({
              mode: replay.mode,
              sampleRate: replay.sampleRate,
              push,
              sessionId,
            })
          )
          .then((handle) => {
            if (handle) {
              errorHandlers.push(() => handle.notifyError());
            }
          })
          .catch(() => {});
      }
    }

    // screenshotOnError, folded into the tier model. A DOM snapshot is only
    // produced when the DOM tier is explicitly chosen AND no full recording is
    // already streaming checkouts; otherwise it degrades to a text-free
    // events-tier breadcrumb. When a collector/recorder is already active for
    // the session it owns error capture, so screenshotOnError adds nothing.
    if (wantScreenshot && !replay.enabled) {
      if (replay.tier === 'dom') {
        void import('./replay/snapshot.js')
          .then(({ captureSnapshot }) => {
            errorHandlers.push((message) => {
              void captureSnapshot(message, push, { block: replay.block });
            });
          })
          .catch(() => {});
      } else {
        void import('./replay/events.js')
          .then(({ pushErrorBreadcrumb }) => {
            errorHandlers.push(() => pushErrorBreadcrumb(push));
          })
          .catch(() => {});
      }
    }
  }

  return faro;
}
