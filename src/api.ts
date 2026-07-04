/**
 * Sentry-compatible convenience API on top of Faro.
 *
 * Mapping:
 *   - `captureException(err, { context, fingerprint })` → `faro.api.pushError`
 *     (`fingerprint` becomes `context.fingerprint`, consumed by the owned
 *     fingerprinting pipeline, nais/grafana-apm-app#62)
 *   - `captureMessage(msg, level)` → `faro.api.pushLog`
 *   - `setUser` / `clearUser` → `faro.api.setUser` / `faro.api.resetUser`
 *   - `setTag` / `setContext` → module-level context merged into every
 *     pushError context. Faro has no first-class tag concept, so this is an
 *     approximation: values ride along as exception context, they are not
 *     indexed labels.
 */

import { LogLevel } from '@grafana/faro-web-sdk';
import type { MetaUser } from '@grafana/faro-web-sdk';

import { getFaroInstance, getGlobalContext } from './internal.js';
import { looksLikePii } from './scrub.js';

export interface CaptureExceptionOptions {
  /** Extra key/value context attached to the exception. Values are stringified. */
  context?: Record<string, unknown>;
  /** Custom grouping key; mapped to `context.fingerprint` (see #62). */
  fingerprint?: string;
}

export type SeverityLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

const SEVERITY_TO_LOG_LEVEL: Record<SeverityLevel, LogLevel> = {
  fatal: LogLevel.ERROR, // Faro has no `fatal`; documented approximation
  error: LogLevel.ERROR,
  warning: LogLevel.WARN,
  log: LogLevel.LOG,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
};

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function stringifyContext(context: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(context ?? {})) {
    if (value !== undefined) {
      out[key] = stringifyValue(value);
    }
  }
  return out;
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === 'string') {
    return new Error(value);
  }
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

/**
 * Capture an exception. Sentry-compatible replacement for
 * `Sentry.captureException`. Note: Faro's `pushError` returns no event ID.
 */
export function captureException(error: unknown, options: CaptureExceptionOptions = {}): void {
  const faro = getFaroInstance();
  if (!faro) {
    return;
  }
  const context: Record<string, string> = {
    ...getGlobalContext(),
    ...stringifyContext(options.context),
  };
  if (options.fingerprint !== undefined) {
    context['fingerprint'] = options.fingerprint;
  }
  faro.api.pushError(toError(error), Object.keys(context).length > 0 ? { context } : undefined);
}

/** Capture a message as a log line. Replacement for `Sentry.captureMessage`. */
export function captureMessage(message: string, level: SeverityLevel = 'info'): void {
  const faro = getFaroInstance();
  if (!faro) {
    return;
  }
  const globalContext = getGlobalContext();
  faro.api.pushLog([message], {
    level: SEVERITY_TO_LOG_LEVEL[level] ?? LogLevel.INFO,
    context: Object.keys(globalContext).length > 0 ? { ...globalContext } : undefined,
  });
}

export interface User {
  /**
   * An **opaque, non-identifying** correlation key — e.g. a salted hash of the
   * user's identity. It MUST NOT be a raw NAV ident, fødselsnummer, email, or
   * name: identities are PII and MUST NOT reach the shared Loki instance (all
   * teams share it). PII-shaped values are dropped by {@link setUser}.
   */
  id?: string;
  /**
   * @deprecated Do not send email — it is PII and MUST NOT reach shared Loki.
   * Any value passed here is dropped by {@link setUser}. Kept only so existing
   * callers still type-check while they migrate off it.
   */
  email?: string;
  /** Opaque, non-identifying label — same rules as {@link User.id}. */
  username?: string;
  /** Extra opaque attributes. PII-shaped values are scrubbed like other fields. */
  attributes?: Record<string, string>;
}

let warnedUserPii = false;

/** @internal test helper — resets the once-only setUser PII warning. */
export function _resetUserPiiWarning(): void {
  warnedUserPii = false;
}

/**
 * Set the active user. Replacement for `Sentry.setUser(user)`.
 *
 * Structured Faro user fields BYPASS the transport-level PII scrubber, so this
 * guards defensively: any `id`/`username`/`attributes` value that looks like
 * PII (fødselsnummer, email, or a raw NAV ident) is dropped, and `email` is
 * dropped unconditionally. Pass an opaque, non-identifying id — never a raw
 * ident, fnr, email, or name.
 *
 * @example setUser({ id: hashedSubject }) // hashedSubject = a salted hash, not an ident
 */
export function setUser(user: User | null): void {
  const faro = getFaroInstance();
  if (!faro) {
    return;
  }
  if (user === null) {
    faro.api.resetUser();
    return;
  }

  const safe: MetaUser = {};
  let dropped = false;

  for (const key of ['id', 'username'] as const) {
    const value = user[key];
    if (value === undefined) {
      continue;
    }
    if (looksLikePii(value)) {
      dropped = true;
      continue;
    }
    safe[key] = value;
  }

  // email is PII by definition — never forward it (the field is deprecated).
  if (user.email !== undefined) {
    dropped = true;
  }

  if (user.attributes) {
    const attributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(user.attributes)) {
      if (looksLikePii(value)) {
        dropped = true;
        continue;
      }
      attributes[key] = value;
    }
    if (Object.keys(attributes).length > 0) {
      safe.attributes = attributes;
    }
  }

  if (dropped && !warnedUserPii) {
    warnedUserPii = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[@nais/apm] setUser value looks like PII (fnr/email) and was dropped — pass an opaque id instead'
    );
  }

  faro.api.setUser(safe);
}

/** Clear the active user. Replacement for `Sentry.setUser(null)`. */
export function clearUser(): void {
  const faro = getFaroInstance();
  if (!faro) {
    return;
  }
  faro.api.resetUser();
}

/**
 * Set a tag merged into every subsequent `captureException`/`captureMessage`
 * context. Approximation of `Sentry.setTag` — Faro has no tag concept.
 */
export function setTag(key: string, value: string | number | boolean): void {
  getGlobalContext()[key] = String(value);
}

/**
 * Attach named context merged (flattened as `name.key`) into every subsequent
 * capture. Approximation of `Sentry.setContext`. Pass `null` to remove.
 */
export function setContext(name: string, context: Record<string, unknown> | null): void {
  const globalContext = getGlobalContext();
  if (context === null) {
    const prefix = `${name}.`;
    for (const key of Object.keys(globalContext)) {
      if (key.startsWith(prefix)) {
        delete globalContext[key];
      }
    }
    return;
  }
  for (const [key, value] of Object.entries(stringifyContext(context))) {
    globalContext[`${name}.${key}`] = value;
  }
}
