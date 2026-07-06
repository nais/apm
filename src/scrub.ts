/**
 * PII scrubbing pipeline, applied as a Faro `beforeSend` hook.
 *
 * Rules (in order):
 *   1. Norwegian fødselsnummer (11 digits, optional space after the first 6,
 *      with a date-prefix sanity check covering D-, H- and synthetic numbers) → `[fnr]`
 *   2. Email addresses → `[email]`
 *   3. `token|access_token|id_token|refresh_token|code|state` query-parameter
 *      values in URL-shaped strings (including `page_url` and stack traces) → `[redacted]`
 *
 * The scrubber walks every string in the transport item payload plus
 * `meta.page.url`. A user-supplied `beforeSend` always runs first; the scrubber
 * always runs last and can only be disabled with `dangerouslyDisablePiiScrubbing`.
 *
 * Best-effort by design: regex scrubbing is not a GDPR guarantee.
 */

import { TransportItemType } from '@grafana/faro-web-sdk';
import type { BeforeSendHook, EventEvent, MeasurementEvent, TransportItem } from '@grafana/faro-web-sdk';

const FNR_CANDIDATE = /\b(\d{6})\s?(\d{5})\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// `:` is excluded from the value so `file.js?token=x:1:2` stack-frame suffixes survive.
const TOKEN_PARAMS = /([?&#](?:access_token|id_token|refresh_token|token|code|state)=)[^&\s#'"<>:]+/gi;

/**
 * Sanity-check that the first six digits of an 11-digit candidate look like a
 * DDMMYY date. Accepts D-numbers (day + 40), H-numbers (month + 40) and
 * synthetic test numbers (month + 80).
 */
function hasPlausibleDatePrefix(dateDigits: string): boolean {
  const day = parseInt(dateDigits.slice(0, 2), 10);
  const month = parseInt(dateDigits.slice(2, 4), 10);
  const dayOk = (day >= 1 && day <= 31) || (day >= 41 && day <= 71);
  const monthOk = (month >= 1 && month <= 12) || (month >= 41 && month <= 52) || (month >= 81 && month <= 92);
  return dayOk && monthOk;
}

/** Scrub a single string. Exposed for reuse and tests. */
export function scrubString(value: string): string {
  let result = value.replace(FNR_CANDIDATE, (match, date: string) =>
    hasPlausibleDatePrefix(date) ? '[fnr]' : match
  );
  result = result.replace(EMAIL, '[email]');
  result = result.replace(TOKEN_PARAMS, '$1[redacted]');
  return result;
}

// A raw NAV ident is a single letter followed by six digits (e.g. `Z994488`).
// This is a direct identifier of a NAV employee and must never be used as a
// correlation key — see {@link looksLikePii}.
const RAW_IDENT = /^[A-Za-z]\d{6}$/;

// A whole path segment that is exactly a fødselsnummer (11 digits, optional
// space) with a plausible date prefix — reuses the {@link scrubString} logic.
const FNR_SEGMENT = /^(\d{6})\s?(\d{5})$/;
// A UUID/GUID path segment (aktør-id, correlation id, …).
const UUID_SEGMENT = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Mask a single URL path segment when it is a PII-shaped identifier. */
function maskPathSegment(segment: string): string {
  if (segment === '' || segment.includes(':')) {
    // Empty (leading/double slash) or the scheme/host:port segment — leave.
    return segment;
  }
  const fnr = FNR_SEGMENT.exec(segment);
  if (fnr && hasPlausibleDatePrefix(fnr[1]!)) {
    return '[fnr]';
  }
  if (UUID_SEGMENT.test(segment)) {
    return '[uuid]';
  }
  if (RAW_IDENT.test(segment)) {
    return '[ident]';
  }
  // Emails and any embedded fnr/token fall through to the shared scrubber.
  return scrubString(segment);
}

/**
 * Sanitize a URL captured for replay/snapshot Meta events. Query string and
 * fragment are dropped entirely (they routinely carry `token=`/`fnr=`), and
 * PII-shaped path segments (fødselsnummer, UUID, NAV ident, email) are masked.
 *
 * Best-effort by the same disclaimer as {@link scrubString}: a name-slug path
 * segment (`/sak/ola-nordmann/`) is not pattern-shaped and survives.
 */
export function scrubUrl(url: string): string {
  if (typeof url !== 'string' || url === '') {
    return url;
  }
  const base = url.split(/[?#]/, 1)[0] ?? url;
  return base.split('/').map(maskPathSegment).join('/');
}

/**
 * Best-effort check for whether a *whole* string looks like personal data:
 * a fødselsnummer, an email, a token-bearing URL param (all reusing the scrub
 * patterns above) or a raw NAV ident. Used to keep PII out of structured Faro
 * fields (e.g. `setUser`) that bypass the transport-level scrubber.
 *
 * Best-effort by design, exactly like {@link scrubString}: a salted/opaque hash
 * passes through, but obvious identifiers are caught.
 */
export function looksLikePii(value: string): boolean {
  // If the scrubber would rewrite it, it contained an fnr/email/token.
  if (scrubString(value) !== value) {
    return true;
  }
  return RAW_IDENT.test(value.trim());
}

const MAX_DEPTH = 8;
// rrweb serialized node trees nest far deeper than a Faro transport item, so the
// replay payload pass ({@link scrubReplayEvents}) walks with a much larger cap.
const REPLAY_MAX_DEPTH = 64;

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>, maxDepth = MAX_DEPTH): unknown {
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (value == null || typeof value !== 'object' || depth >= maxDepth) {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, depth + 1, seen, maxDepth));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = scrubValue(entry, depth + 1, seen, maxDepth);
  }
  return out;
}

/**
 * Deep-scrub every string leaf of a serialized rrweb replay/snapshot payload.
 *
 * The replay transport gzips chunks before Faro's `beforeSend` scrubber ever
 * sees them, so this is the only layer where the fnr/email/token patterns can
 * match attribute values and URLs inside the (uncompressed) rrweb node tree.
 * Runs on the plain JSON events just before gzip; masked text (`***…`) scrubs
 * to a no-op, so it earns its keep on attributes and URLs the rrweb floor never
 * masks. Best-effort by the same disclaimer as {@link scrubString}.
 */
export function scrubReplayEvents<T>(events: T): T {
  return scrubValue(events, 0, new WeakSet(), REPLAY_MAX_DEPTH) as T;
}

/**
 * Redact bare NAV idents (a single letter + six digits, e.g. `Z994455`) in a
 * string→string label map — measurement `context` or event `attributes`.
 *
 * These maps are free-form string labels teams attach to custom telemetry, and
 * they routinely carry a raw NAV ident (a direct employee identifier that must
 * never reach shared Loki). The generic {@link scrubValue} pass has already run
 * over these values, so fnr/email/token are handled; the only PII class left is
 * a whole-value ident, which those patterns pass. Detection reuses
 * {@link looksLikePii} — the same check the `setUser` path uses — and, on an
 * already-scrubbed value, it fires only on {@link RAW_IDENT}. Whole-value match
 * only, so ordinary low-cardinality labels (`step-2`, `checkout`) are untouched.
 */
function redactIdentLabels(labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    out[key] = typeof value === 'string' && looksLikePii(value) ? '[ident]' : value;
  }
  return out;
}

/** Deep-scrub every string in a transport item (payload + page URL), without mutating the input. */
export function scrubTransportItem(item: TransportItem): TransportItem {
  const payload = scrubValue(item.payload, 0, new WeakSet()) as TransportItem['payload'];

  // Ident layer: measurement `context` and event `attributes` are free-form
  // string label maps that carry NAV idents (Z-numbers) the fnr/email/token
  // patterns above don't catch. Numeric measurement `values` are the metric
  // itself and are deliberately left untouched (scrubValue never rewrites
  // numbers). `payload` is a fresh deep copy, so mutating it here is safe.
  if (item.type === TransportItemType.MEASUREMENT) {
    const measurement = payload as MeasurementEvent;
    if (measurement.context) {
      measurement.context = redactIdentLabels(measurement.context);
    }
  } else if (item.type === TransportItemType.EVENT) {
    const event = payload as EventEvent;
    if (event.attributes) {
      event.attributes = redactIdentLabels(event.attributes);
    }
  }

  const scrubbed: TransportItem = { ...item, payload };
  const pageUrl = item.meta?.page?.url;
  if (typeof pageUrl === 'string') {
    scrubbed.meta = {
      ...item.meta,
      page: { ...item.meta.page, url: scrubString(pageUrl) },
    };
  }
  return scrubbed;
}

/**
 * Compose the user's `beforeSend` (runs first, may drop items) with the PII
 * scrubber (always last). Pass `disableScrubbing` only via
 * `dangerouslyDisablePiiScrubbing: true`.
 */
export function composeBeforeSend(
  userBeforeSend: BeforeSendHook | undefined,
  disableScrubbing = false
): BeforeSendHook | undefined {
  if (disableScrubbing) {
    return userBeforeSend;
  }
  return (item) => {
    const afterUser = userBeforeSend ? userBeforeSend(item) : item;
    if (afterUser === null) {
      return null;
    }
    return scrubTransportItem(afterUser);
  };
}
