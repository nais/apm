/**
 * Opt-in browser tracing (nais/grafana-apm-app#80).
 *
 * Lazily loaded from `init({ tracing: true })` — exactly like session replay —
 * so `@grafana/faro-web-tracing` and its OpenTelemetry dependency tree stay out
 * of the bundle of every app that does not ask for tracing. `startTracing`
 * late-adds a `TracingInstrumentation` via `faro.instrumentations.add`, which
 * initializes the instrumentation on the spot (no need to make `init()` async).
 */

import { TracingInstrumentation } from '@grafana/faro-web-tracing';
import type { Faro, Patterns } from '@grafana/faro-web-sdk';

/**
 * Non-overridable trace-header propagation floor (security).
 *
 * Distributed tracing injects `traceparent`/`tracestate` headers into outgoing
 * requests. Those headers must ONLY be sent to nais-owned backends — never to
 * arbitrary third parties — because they leak the internal trace topology and
 * would trip CORS on foreign origins. This base is therefore hard-coded and can
 * never be replaced or emptied: extra origins are only ever APPENDED to it (via
 * `propagateExtraOrigins`), the same tighten-only philosophy as the replay
 * masking floor. It is deliberately unreachable through the `options.faro`
 * escape hatch.
 *
 *   - the app's own origin (exact prefix), so same-origin API calls are traced;
 *   - any `*.nav.no` host over https.
 */
function sameOriginPrefix(): string | undefined {
  if (typeof window === 'undefined' || !window.location?.origin) {
    return undefined;
  }
  return window.location.origin;
}

const NAV_NO_HTTPS = /^https:\/\/[^/]*\.nav\.no/;

/** Build the mandatory propagation base for the current origin. */
export function buildPropagationBase(): Patterns {
  const base: Patterns = [];
  const origin = sameOriginPrefix();
  if (origin !== undefined) {
    base.push(origin);
  }
  base.push(NAV_NO_HTTPS);
  return base;
}

export interface StartTracingOptions {
  /**
   * Extra origins to propagate trace headers to, APPENDED to the mandatory
   * same-origin + `*.nav.no` base. Cannot remove or replace the base.
   */
  propagateExtraOrigins?: Patterns;
  /**
   * @internal test seam: replaces the real `TracingInstrumentation`. Lets tests
   * assert what gets added and with which propagation list, without pulling the
   * full OpenTelemetry SDK.
   */
  instrumentationFactory?: (propagateTraceHeaderCorsUrls: Patterns) => unknown;
}

/**
 * Compute the final, non-overridable `propagateTraceHeaderCorsUrls` list: the
 * mandatory base first, then any caller-supplied extra origins appended. The
 * base is always present and can never be emptied.
 */
export function resolvePropagateUrls(extra: Patterns | undefined): Patterns {
  return [...buildPropagationBase(), ...(extra ?? [])];
}

/**
 * Start browser tracing on an already-initialized Faro instance. Never throws —
 * tracing must not be able to break the host app.
 */
export function startTracing(faro: Faro, options: StartTracingOptions = {}): void {
  try {
    const propagateTraceHeaderCorsUrls = resolvePropagateUrls(options.propagateExtraOrigins);
    const instrumentation =
      options.instrumentationFactory?.(propagateTraceHeaderCorsUrls) ??
      new TracingInstrumentation({
        instrumentationOptions: { propagateTraceHeaderCorsUrls },
      });
    // Late-add: faro-core's `instrumentations.add` wires api/config/transports
    // and calls `initialize()` immediately, so no need to make init() async.
    faro.instrumentations.add(instrumentation as never);
  } catch {
    // Tracing is best-effort; failures must never surface to the host app.
  }
}
