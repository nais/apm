import { afterEach, describe, expect, it, vi } from 'vitest';
import type { API, PushErrorOptions } from '@grafana/faro-web-sdk';

import { FARO_ERRORS_INSTRUMENTATION_NAME, NaisErrorsInstrumentation } from './errors.js';

type PushErrorCall = [Error, PushErrorOptions | undefined];

function createInstrumentation() {
  const pushError = vi.fn();
  const instrumentation = new NaisErrorsInstrumentation();
  // Faro injects `api` when registering instrumentations; emulate that.
  instrumentation.api = { pushError } as unknown as API;
  instrumentation.initialize();
  return { instrumentation, pushError };
}

describe('NaisErrorsInstrumentation', () => {
  const nativeOnerror = window.onerror;
  let active: NaisErrorsInstrumentation | undefined;

  afterEach(() => {
    active?.destroy();
    active = undefined;
    window.onerror = nativeOnerror;
  });

  it('exposes the same name Faro registers its built-in instrumentation under, for exclusion', () => {
    expect(FARO_ERRORS_INSTRUMENTATION_NAME).toBe('@grafana/faro-web-sdk:instrumentation-errors');
  });

  describe('unhandledrejection', () => {
    it('forwards the real Error as originalError', () => {
      const { instrumentation, pushError } = createInstrumentation();
      active = instrumentation;

      const reason = new Error('async boom');
      window.dispatchEvent(
        Object.assign(new Event('unhandledrejection'), { reason, promise: Promise.reject().catch(() => {}) })
      );

      expect(pushError).toHaveBeenCalledTimes(1);
      const [pushedError, options] = pushError.mock.calls[0] as PushErrorCall;
      expect(pushedError.message).toBe('async boom');
      expect(options?.originalError).toBe(reason);
    });

    it('does not set originalError for a primitive rejection reason', () => {
      const { instrumentation, pushError } = createInstrumentation();
      active = instrumentation;

      window.dispatchEvent(
        Object.assign(new Event('unhandledrejection'), { reason: 'plain string', promise: Promise.reject().catch(() => {}) })
      );

      expect(pushError).toHaveBeenCalledTimes(1);
      const [pushedError, options] = pushError.mock.calls[0] as PushErrorCall;
      expect(pushedError.message).toContain('plain string');
      expect(options?.originalError).toBeUndefined();
    });

    it('removes its listener on destroy()', () => {
      const { instrumentation, pushError } = createInstrumentation();
      active = instrumentation;
      instrumentation.destroy();
      active = undefined;

      window.dispatchEvent(
        Object.assign(new Event('unhandledrejection'), {
          reason: new Error('after destroy'),
          promise: Promise.reject().catch(() => {}),
        })
      );

      expect(pushError).not.toHaveBeenCalled();
    });

    it('falls back to describing the whole event when reason is falsy (matches Faro upstream)', () => {
      const { instrumentation, pushError } = createInstrumentation();
      active = instrumentation;

      // No `.reason` and no `.detail.reason` at all — Faro's own
      // `registerOnunhandledrejection` falls back to treating the event
      // itself as the "error", instead of silently reporting "undefined".
      window.dispatchEvent(
        Object.assign(new Event('unhandledrejection'), { reason: null, promise: Promise.reject().catch(() => {}) })
      );

      expect(pushError).toHaveBeenCalledTimes(1);
      const [pushedError, options] = pushError.mock.calls[0] as PushErrorCall;
      expect(pushedError.message).toContain('Non-Error exception captured with keys:');
      expect(options?.originalError).toBeUndefined();
    });

    it('does not set originalError for a plain object rejection reason', () => {
      const { instrumentation, pushError } = createInstrumentation();
      active = instrumentation;

      window.dispatchEvent(
        Object.assign(new Event('unhandledrejection'), {
          reason: { code: 'ECONNRESET' },
          promise: Promise.reject().catch(() => {}),
        })
      );

      expect(pushError).toHaveBeenCalledTimes(1);
      const [pushedError, options] = pushError.mock.calls[0] as PushErrorCall;
      expect(pushedError.message).toContain('Non-Error exception captured with keys:');
      expect(pushedError.message).toContain('code');
      expect(options?.originalError).toBeUndefined();
    });
  });

  describe('window.onerror', () => {
    it('forwards the real Error as originalError (parity with Faro upstream)', () => {
      const { instrumentation, pushError } = createInstrumentation();
      active = instrumentation;

      const err = new Error('sync boom');
      window.onerror?.('sync boom', 'app.js', 1, 1, err);

      expect(pushError).toHaveBeenCalledTimes(1);
      const [pushedError, options] = pushError.mock.calls[0] as PushErrorCall;
      expect(pushedError.message).toBe('sync boom');
      expect(options?.originalError).toBe(err);
    });

    it('chains to a previously registered window.onerror', () => {
      const previous = vi.fn();
      window.onerror = previous;

      const { instrumentation } = createInstrumentation();
      active = instrumentation;

      window.onerror?.('sync boom', 'app.js', 1, 1, new Error('sync boom'));

      expect(previous).toHaveBeenCalledTimes(1);
    });
  });

  describe('idempotency and lifecycle safety', () => {
    it('calling initialize() twice does not install duplicate listeners', () => {
      const { instrumentation, pushError } = createInstrumentation();
      active = instrumentation;
      instrumentation.initialize(); // second call must be a no-op

      window.dispatchEvent(
        Object.assign(new Event('unhandledrejection'), {
          reason: new Error('once only'),
          promise: Promise.reject().catch(() => {}),
        })
      );
      window.onerror?.('sync boom', 'app.js', 1, 1, new Error('sync boom'));

      // One push per event, not two — a second init() would otherwise stack
      // another onerror wrapper and another unhandledrejection listener.
      expect(pushError).toHaveBeenCalledTimes(2);
    });

    it('destroy() does not clobber a window.onerror installed by other code afterwards', () => {
      const { instrumentation } = createInstrumentation();
      active = instrumentation;

      const laterHandler = vi.fn();
      window.onerror = laterHandler; // some other library takes over after us

      instrumentation.destroy();
      active = undefined;

      // Our destroy() must not have restored the pre-init handler over the
      // top of `laterHandler` — that would silently disable it.
      expect(window.onerror).toBe(laterHandler);
    });

    it('destroy() restores the prior handler when nothing else replaced ours', () => {
      const previous = vi.fn();
      window.onerror = previous;

      const { instrumentation } = createInstrumentation();
      active = instrumentation;
      instrumentation.destroy();
      active = undefined;

      expect(window.onerror).toBe(previous);
    });
  });
});
