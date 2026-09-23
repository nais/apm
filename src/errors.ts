/**
 * Replacement `window.onerror` + `unhandledrejection` instrumentation.
 *
 * Faro's built-in `ErrorsInstrumentation` (`@grafana/faro-web-sdk` 2.11.0)
 * already forwards the real `Error` as `pushError`'s `originalError` option
 * for `window.onerror` — but NOT for `unhandledrejection`
 * (`registerOnunhandledrejection` only passes `{ type, stackFrames }`). With
 * `preserveOriginalError` enabled that means a rejected promise's actual
 * Error instance never reaches a custom `beforeSend`. Worse: because Faro's
 * listener is registered first (during `init()`, before application code
 * runs), it pushes its `originalError`-less item first; if the application
 * also listens for `unhandledrejection` and calls `captureException` with the
 * same error, Faro's `dedupe` (on by default) sees an identical payload and
 * silently drops the second, "good" call.
 *
 * This instrumentation is a drop-in replacement for Faro's
 * `ErrorsInstrumentation` — `window.onerror` behavior matches upstream, and
 * `unhandledrejection` is the same logic (including its `reason`/`detail`
 * fallback chain) with `originalError` added — so there is exactly one
 * listener per event type and no dedupe race. Idempotent (`initialize()`
 * twice is a no-op) and `destroy()` only restores a previously-installed
 * `window.onerror` if nothing else has replaced it since. `init()` excludes
 * the built-in `ErrorsInstrumentation` from `getWebInstrumentations()` and
 * registers this one instead (same pattern as `NaisConsoleInstrumentation`,
 * nais/grafana-apm-app#66).
 */

import {
  BaseInstrumentation,
  buildStackFrame,
  defaultExceptionType,
  getStackFramesFromError,
  isDomError,
  isDomException,
  isError,
  isErrorEvent,
  isEvent,
  isObject,
  isPrimitive,
  isString,
} from '@grafana/faro-web-sdk';
import type { ExceptionStackFrame, PushErrorOptions } from '@grafana/faro-web-sdk';

import { VERSION } from './version.js';

/** Name Faro's own instrumentation registers under — excluded in `init()`. */
export const FARO_ERRORS_INSTRUMENTATION_NAME = '@grafana/faro-web-sdk:instrumentation-errors';

const PRIMITIVE_UNHANDLED_VALUE = 'Non-Error promise rejection captured with value:';
const PRIMITIVE_UNHANDLED_TYPE = 'UnhandledRejection';
const DOM_ERROR_TYPE = 'DOMError';
const DOM_EXCEPTION_TYPE = 'DOMException';
const OBJECT_EVENT_VALUE = 'Non-Error exception captured with keys:';

// Ported verbatim from Faro's internal `valueTypeRegex` — extracts an
// `Error:`-style name/message pair out of a plain onerror string message.
const VALUE_TYPE_REGEX =
  /^(?:[Uu]ncaught (?:exception: )?)?(?:((?:Eval|Internal|Range|Reference|Syntax|Type|URI|)Error): )?(.*)$/i;

function getValueAndTypeFromMessage(message: string): [string, string] {
  const groups = message.match(VALUE_TYPE_REGEX);
  return [groups?.[2] ?? message, groups?.[1] ?? defaultExceptionType];
}

interface ErrorDetails {
  value: string | undefined;
  type: string | undefined;
  stackFrames: ExceptionStackFrame[];
}

/** Port of Faro's internal `getErrorDetails` (window.onerror + unhandledrejection reason parsing). */
function getErrorDetails(evt: unknown): ErrorDetails {
  let value: string | undefined;
  let type: string | undefined;
  let stackFrames: ExceptionStackFrame[] = [];

  if (isErrorEvent(evt) && (evt as ErrorEvent).error) {
    const error = (evt as ErrorEvent).error as Error;
    value = error.message;
    type = error.name;
    stackFrames = getStackFramesFromError(error);
  } else if (isDomError(evt) || isDomException(evt)) {
    const { name, message } = evt as DOMException;
    type = name || (isDomError(evt) ? DOM_ERROR_TYPE : DOM_EXCEPTION_TYPE);
    value = message ? `${type}: ${message}` : type;
  } else if (isError(evt)) {
    type = evt.name;
    value = evt.message;
    stackFrames = getStackFramesFromError(evt);
  } else if (isObject(evt) || isEvent(evt)) {
    type = isEvent(evt) ? (evt as object).constructor.name : undefined;
    value = `${OBJECT_EVENT_VALUE} ${Object.keys(evt as object)}`;
  }

  return { value, type, stackFrames };
}

/** Port of Faro's internal `getDetailsFromErrorArgs` (window.onerror's 5-arg callback shape). */
function getDetailsFromErrorArgs(args: [unknown, string?, number?, number?, unknown?]): ErrorDetails {
  const [evt, source, lineno, colno, error] = args;
  const eventIsString = isString(evt);
  const initialStackFrame = buildStackFrame(source, '?', lineno, colno);

  if (error || !eventIsString) {
    const details = getErrorDetails(error ?? evt);
    return {
      value: details.value,
      type: details.type,
      stackFrames: details.stackFrames.length > 0 ? details.stackFrames : [initialStackFrame],
    };
  }

  const [value, type] = getValueAndTypeFromMessage(evt as string);
  return { value, type, stackFrames: [initialStackFrame] };
}

function registerOnerror(instrumentation: NaisErrorsInstrumentation): void {
  const oldOnerror = window.onerror;

  window.onerror = (...args: [unknown, string?, number?, number?, unknown?]) => {
    try {
      const { value, type, stackFrames } = getDetailsFromErrorArgs(args);
      const originalError = args[4];

      if (value) {
        const options: PushErrorOptions = { type, stackFrames };
        if (originalError != null) {
          options.originalError = originalError as Error;
        }
        instrumentation.api.pushError(new Error(value), options);
      }
    } finally {
      oldOnerror?.apply(window, args as Parameters<typeof oldOnerror>);
    }
  };
}

function registerOnunhandledrejection(instrumentation: NaisErrorsInstrumentation): void {
  const handler = (evt: PromiseRejectionEvent): void => {
    const detail = (evt as PromiseRejectionEvent & { detail?: { reason: unknown } }).detail;
    // Port of Faro's exact fallback chain: prefer `evt.reason`, then
    // `evt.detail?.reason` (older Cordova/polyfill shape), and — if NEITHER
    // is truthy (e.g. reason is `null`/`undefined`/`0`/`''`) — fall through to
    // treating the whole event itself as the "error" to describe, same as
    // upstream. Losing this fallback would silently drop such rejections
    // instead of reporting a synthetic "Non-Error exception" for them.
    let reason: unknown = evt;
    if (evt.reason) {
      reason = evt.reason;
    } else if (detail?.reason) {
      reason = detail.reason;
    }

    let value: string | undefined;
    let type: string | undefined;
    let stackFrames: ExceptionStackFrame[] = [];
    // The fix: an actual Error reason is the only shape that can carry
    // `originalError` (Faro types it as `Error`) — primitives/plain objects
    // never had one to preserve in the first place.
    const originalError = reason instanceof Error ? reason : undefined;

    if (isPrimitive(reason)) {
      value = `${PRIMITIVE_UNHANDLED_VALUE} ${String(reason)}`;
      type = PRIMITIVE_UNHANDLED_TYPE;
    } else {
      ({ value, type, stackFrames } = getErrorDetails(reason));
    }

    if (value) {
      const options: PushErrorOptions = { type, stackFrames };
      if (originalError) {
        options.originalError = originalError;
      }
      instrumentation.api.pushError(new Error(value), options);
    }
  };

  window.addEventListener('unhandledrejection', handler);
  instrumentation.unhandledRejectionHandler = handler;
}

export class NaisErrorsInstrumentation extends BaseInstrumentation {
  readonly name = '@nais/apm-errors-instrumentation';
  readonly version = VERSION;

  private previousOnerror: typeof window.onerror | undefined;
  private installedOnerror: typeof window.onerror | undefined;
  /** @internal exposed for tests */
  unhandledRejectionHandler: ((evt: PromiseRejectionEvent) => void) | undefined;

  initialize(): void {
    if (this.installedOnerror) {
      return; // already patched; stay idempotent (see NaisConsoleInstrumentation)
    }
    this.previousOnerror = window.onerror;
    registerOnerror(this);
    this.installedOnerror = window.onerror;
    registerOnunhandledrejection(this);
  }

  destroy(): void {
    if (this.unhandledRejectionHandler) {
      window.removeEventListener('unhandledrejection', this.unhandledRejectionHandler);
      this.unhandledRejectionHandler = undefined;
    }
    // Only restore the PRE-init handler if `window.onerror` is still the
    // wrapper we installed — some other code may have replaced it since
    // (e.g. another instrumentation/library); stomping on that would silently
    // disable its error reporting.
    if (this.installedOnerror && window.onerror === this.installedOnerror) {
      window.onerror = this.previousOnerror ?? null;
    }
    this.installedOnerror = undefined;
    this.previousOnerror = undefined;
  }
}
