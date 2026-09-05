/**
 * PII scrubbing pipeline, applied as a Faro `beforeSend` hook.
 *
 * Rules (in order):
 *   1. Email addresses → `[email]` (first, so an fnr inside an address cannot
 *      break the email match — see {@link scrubString})
 *   2. Norwegian fødselsnummer (11 digits, optional space after the first 6,
 *      with a date-prefix sanity check covering D-, H- and synthetic numbers) → `[fnr]`.
 *      A run glued to a letter/underscore must additionally pass the mod11
 *      control digits — see {@link maskFnr}.
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

// No boundary assertion at all — {@link maskFnr} inspects the neighbouring
// characters itself. A digit-only lookbehind would express this more directly,
// but lookbehind is a SyntaxError at *parse* time on Safari < 16.4, which would
// take down the whole host bundle the moment it imports this SDK. An
// observability library must never brick the page it is measuring, so this file
// stays lookbehind-free — pinned by a test in scrub.property.test.ts.
const FNR_CANDIDATE = /(\d{6})\s?(\d{5})/g;
const DIGIT = /[0-9]/;
// `\b` treated letters, `_` and digits alike, which let `bruker01017000027`
// through (nais/apm#20). Digits still block a match outright (11 digits inside a
// longer number are not an fnr); these characters no longer do, but a match
// touching one of them needs mod11 to qualify.
// ASCII-only, exactly like the `\b` it replaces: `æøå` and other non-ASCII
// letters take the delimiter path and mask on the date prefix alone. That errs
// toward *more* scrubbing, so it is left as is.
const WORD_GLUE = /[A-Za-z_]/;
// Hex identifiers (OTel traceId/spanId, UUIDs) are long runs of `[0-9a-f]`, and
// this SDK puts them in its own payloads. Roughly 1 in 100k random 32-char
// traceIds contains an 11-digit slice that clears both mod11 digits and a
// plausible date, which used to rewrite the id and break trace correlation —
// worse, `looksLikePii` then flagged the whole value and `[ident]`-ed it out of
// measurement context. A real letter-glued fnr in prose is never flanked by hex
// letters on BOTH sides, while `bruker`/`sak`-style prefixes glue on one side
// only, so requiring both keeps #20's fix intact.
// Measured cut (independent 2-3M-sample corpora per shape): traceId 32-hex
// ~70%, sessionId 20-hex ~64%, spanId 16-hex ~48% — and dashed UUIDs 0%: an
// 11-digit run in a UUID group is flanked by `-` (a delimiter, not a hex
// letter), so this guard never fires there (~1/133k UUIDs still rewritten).
// ponytail: the residual is runs at a hex id's edges or next to `-`. Upgrade
// path if that ever bites: treat `-` between hex groups as hex context, or skip
// when the maximal surrounding `[0-9a-f-]` run is >= 12 chars — both still mask
// `bruker01017000027` (`r`/`u` are not hex letters).
const HEX_LETTER = /[a-f]/;
// Quantifiers are bounded to their RFC 5321 limits (local part 64, domain 255)
// rather than left as `+`. Unbounded, a long run of local-part characters with
// no `@` — easily reached in an rrweb payload — makes the engine rescan the run
// from every start position: 490ms of main-thread jank on a 32k-char string,
// versus 4.6ms bounded. `scrubString` runs on every string of every telemetry
// item in the user's browser, so that is a real freeze, not a theoretical one.
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}/g;
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

// Weights for the two mod11 control digits of a fødselsnummer: k1 over digits
// 1–9, k2 over digits 1–10.
const K1_WEIGHTS = [3, 7, 6, 1, 8, 9, 4, 5, 2];
const K2_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

function controlDigit(digits: string, weights: number[]): number {
  const sum = weights.reduce((acc, weight, i) => acc + weight * Number(digits[i]), 0);
  const rest = 11 - (sum % 11);
  // 11 → 0; 10 is invalid and can never equal a digit, so it fails the compare.
  return rest === 11 ? 0 : rest;
}

/** Both mod11 control digits of an 11-digit fnr check out. */
function hasValidControlDigits(digits: string): boolean {
  return (
    controlDigit(digits, K1_WEIGHTS) === Number(digits[9]) &&
    controlDigit(digits, K2_WEIGHTS) === Number(digits[10])
  );
}

/**
 * Replace every fødselsnummer in `value` with `[fnr]`.
 *
 * The rule is asymmetric on purpose:
 *   - a digit on either side disqualifies the match outright — 11 digits inside
 *     a longer number are not an fnr (the false-positive guard `\b` gave us);
 *   - a letter or `_` on either side requires the two mod11 control digits to
 *     check out, which is what keeps case numbers and external identifiers that
 *     merely contain a plausible 11-digit run intact;
 *   - a lowercase hex letter on *both* sides disqualifies it outright — that is
 *     a slice of a traceId/spanId/UUID, not an fnr in prose (see
 *     {@link HEX_LETTER});
 *   - anything else (space, punctuation, string edges) masks on the date-prefix
 *     check alone — the historical behaviour, so a mistyped or partially
 *     mangled fnr still never leaves the browser.
 *
 * Hand-rolled scan rather than `String#replace`, because a rejected candidate
 * must give its characters back: in `123456 01017000027` the greedy `\s?` first
 * matches `123456 01017`, and skipping past that would swallow the real fnr that
 * starts inside it. Resuming one character in reproduces exactly what the
 * (unusable, see {@link FNR_CANDIDATE}) lookaround form would have matched.
 */
function maskFnr(value: string): string {
  FNR_CANDIDATE.lastIndex = 0;
  let out = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = FNR_CANDIDATE.exec(value)) !== null) {
    const [text, date = '', tail = ''] = match;
    const before = value[match.index - 1] ?? '';
    const after = value[match.index + text.length] ?? '';
    const glued = WORD_GLUE.test(before) || WORD_GLUE.test(after);
    const insideHex = HEX_LETTER.test(before) && HEX_LETTER.test(after);
    const accepted =
      !DIGIT.test(before) &&
      !DIGIT.test(after) &&
      !insideHex &&
      hasPlausibleDatePrefix(date) &&
      (!glued || hasValidControlDigits(date + tail));
    if (accepted) {
      out += value.slice(cursor, match.index) + '[fnr]';
      cursor = match.index + text.length;
      FNR_CANDIDATE.lastIndex = cursor;
    } else {
      FNR_CANDIDATE.lastIndex = match.index + 1;
    }
  }
  return out + value.slice(cursor);
}

/**
 * Scrub a single string. Exposed for reuse and tests.
 *
 * Email runs *before* the fnr pass. `[fnr]` contains `]`, which is outside
 * EMAIL's character classes, so masking an fnr first destroys any email that
 * contained one: `ola.nordmann01017000027@nav.no` became `ola.nordmann[fnr]@nav.no`
 * and leaked the address. EMAIL needs an `@`, so it can never steal a bare fnr,
 * and it swallows `01017000027@nav.no` whole instead of leaving the domain behind.
 */
export function scrubString(value: string): string {
  let result = value.replace(EMAIL, '[email]');
  result = maskFnr(result);
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
