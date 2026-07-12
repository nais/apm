import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogLevel } from '@grafana/faro-web-sdk';
import type { Faro } from '@grafana/faro-web-sdk';

import {
  _resetUserPiiWarning,
  captureException,
  captureMessage,
  clearUser,
  pushEvent,
  pushMeasurement,
  setContext,
  setTag,
  setUser,
} from './api.js';
import { _resetStateForTesting, setFaroInstance, startPreInitBuffering } from './internal.js';

function createFakeFaro() {
  const api = {
    pushError: vi.fn(),
    pushLog: vi.fn(),
    pushMeasurement: vi.fn(),
    pushEvent: vi.fn(),
    setUser: vi.fn(),
    resetUser: vi.fn(),
  };
  return { faro: { api } as unknown as Faro, api };
}

describe('Sentry-compat API', () => {
  let api: ReturnType<typeof createFakeFaro>['api'];

  beforeEach(() => {
    _resetStateForTesting();
    _resetUserPiiWarning();
    const fake = createFakeFaro();
    api = fake.api;
    setFaroInstance(fake.faro);
  });

  describe('captureException', () => {
    it('pushes the error through faro.api.pushError', () => {
      const err = new Error('boom');
      captureException(err);
      expect(api.pushError).toHaveBeenCalledWith(err, undefined);
    });

    it('maps fingerprint to context.fingerprint (#62)', () => {
      const err = new Error('boom');
      captureException(err, { fingerprint: 'checkout-payment-failure' });
      expect(api.pushError).toHaveBeenCalledWith(err, {
        context: { fingerprint: 'checkout-payment-failure' },
      });
    });

    it('passes context and stringifies non-string values', () => {
      captureException(new Error('x'), { context: { form: 'step-2', attempt: 3 } });
      expect(api.pushError.mock.calls[0]?.[1]).toEqual({
        context: { form: 'step-2', attempt: '3' },
      });
    });

    it('merges module-level tags and contexts, per-call context wins', () => {
      setTag('team', 'dagpenger');
      setContext('feature', { nyFlyt: 'variant-b' });
      captureException(new Error('x'), { context: { 'feature.nyFlyt': 'override' } });
      expect(api.pushError.mock.calls[0]?.[1]).toEqual({
        context: { team: 'dagpenger', 'feature.nyFlyt': 'override' },
      });
    });

    it('coerces non-Error values', () => {
      captureException('plain string failure');
      const pushed = api.pushError.mock.calls[0]?.[0] as Error;
      expect(pushed).toBeInstanceOf(Error);
      expect(pushed.message).toBe('plain string failure');
    });

    it('is a no-op with a single warning before init()', () => {
      _resetStateForTesting();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      captureException(new Error('x'));
      captureException(new Error('y'));
      expect(api.pushError).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('captureMessage', () => {
    it('pushes a log with the mapped level', () => {
      captureMessage('deploy finished', 'warning');
      expect(api.pushLog).toHaveBeenCalledWith(['deploy finished'], {
        level: LogLevel.WARN,
        context: undefined,
      });
    });

    it('defaults to info', () => {
      captureMessage('hello');
      expect(api.pushLog.mock.calls[0]?.[1]).toMatchObject({ level: LogLevel.INFO });
    });

    it('includes module-level context', () => {
      setTag('team', 'pensjon');
      captureMessage('hi');
      expect(api.pushLog.mock.calls[0]?.[1]).toMatchObject({ context: { team: 'pensjon' } });
    });
  });

  describe('user handling', () => {
    it('setUser forwards an opaque id/username to faro.api.setUser', () => {
      setUser({ id: 'a1b2c3', username: 'ola' });
      expect(api.setUser).toHaveBeenCalledWith({ id: 'a1b2c3', username: 'ola' });
    });

    it('setUser(null) and clearUser reset the user', () => {
      setUser(null);
      clearUser();
      expect(api.resetUser).toHaveBeenCalledTimes(2);
    });

    it('drops a fødselsnummer id and warns once', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setUser({ id: '01017012345', username: 'ola' });
      expect(api.setUser).toHaveBeenCalledWith({ username: 'ola' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('looks like PII');
      warn.mockRestore();
    });

    it('drops an email-shaped username', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      setUser({ id: 'opaque', username: 'ola@nav.no' });
      expect(api.setUser).toHaveBeenCalledWith({ id: 'opaque' });
    });

    it('drops the deprecated email field unconditionally and warns', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      setUser({ id: 'opaque', email: 'user@example.com' });
      expect(api.setUser).toHaveBeenCalledWith({ id: 'opaque' });
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('drops a raw NAV ident id', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      setUser({ id: 'Z994488' });
      expect(api.setUser).toHaveBeenCalledWith({});
    });

    it('lets an opaque hashed id and safe attributes through untouched', () => {
      setUser({ id: 'sha256:deadbeefcafef00d', attributes: { plan: 'premium' } });
      expect(api.setUser).toHaveBeenCalledWith({
        id: 'sha256:deadbeefcafef00d',
        attributes: { plan: 'premium' },
      });
    });

    it('drops a PII-shaped attribute value', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      setUser({ id: 'opaque', attributes: { contact: 'user@example.com', plan: 'free' } });
      expect(api.setUser).toHaveBeenCalledWith({ id: 'opaque', attributes: { plan: 'free' } });
    });
  });

  describe('setContext', () => {
    it('removes a named context when passed null', () => {
      setContext('feature', { a: '1', b: '2' });
      setContext('feature', null);
      captureException(new Error('x'));
      expect(api.pushError).toHaveBeenCalledWith(expect.any(Error), undefined);
    });
  });

  describe('custom telemetry wrappers', () => {
    it('pushMeasurement calls through to faro.api.pushMeasurement', () => {
      pushMeasurement('checkout_latency', { ms: 812 });
      expect(api.pushMeasurement).toHaveBeenCalledWith({ type: 'checkout_latency', values: { ms: 812 } });
    });

    it('pushMeasurement forwards context labels', () => {
      pushMeasurement('checkout_latency', { ms: 812 }, { context: { page: 'oversikt' } });
      expect(api.pushMeasurement).toHaveBeenCalledWith({
        type: 'checkout_latency',
        values: { ms: 812 },
        context: { page: 'oversikt' },
      });
    });

    it('pushEvent calls through to faro.api.pushEvent', () => {
      pushEvent('feature_flag_evaluated', { flag: 'new-checkout', value: 'on' });
      expect(api.pushEvent).toHaveBeenCalledWith(
        'feature_flag_evaluated',
        { flag: 'new-checkout', value: 'on' },
        undefined
      );
    });

    it('pushMeasurement/pushEvent are no-ops before init()', () => {
      _resetStateForTesting();
      pushMeasurement('m', { v: 1 });
      pushEvent('e');
      expect(api.pushMeasurement).not.toHaveBeenCalled();
      expect(api.pushEvent).not.toHaveBeenCalled();
    });
  });

  describe('pre-init buffering (initFromConfigUrl in flight)', () => {
    beforeEach(() => {
      _resetStateForTesting();
    });

    it('buffers capture calls and flushes them on init, in order', () => {
      const fake = createFakeFaro();
      startPreInitBuffering();

      const err = new Error('early');
      captureException(err);
      captureMessage('early message');
      pushEvent('early_event');
      expect(fake.api.pushError).not.toHaveBeenCalled();

      setFaroInstance(fake.faro);

      expect(fake.api.pushError).toHaveBeenCalledWith(err, undefined);
      expect(fake.api.pushLog).toHaveBeenCalledWith(['early message'], {
        level: LogLevel.INFO,
        context: undefined,
      });
      expect(fake.api.pushEvent).toHaveBeenCalledWith('early_event', undefined, undefined);
      expect(fake.api.pushError.mock.invocationCallOrder[0]).toBeLessThan(
        fake.api.pushLog.mock.invocationCallOrder[0]!
      );
    });

    it('snapshots global context at call time, not flush time', () => {
      const fake = createFakeFaro();
      startPreInitBuffering();

      setTag('phase', 'before');
      captureException(new Error('x'));
      setTag('phase', 'after'); // must not leak into the already-buffered call

      setFaroInstance(fake.faro);
      expect(fake.api.pushError.mock.calls[0]?.[1]).toEqual({ context: { phase: 'before' } });
    });

    it('buffered calls do not fire the not-initialized warning', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      startPreInitBuffering();
      captureException(new Error('x'));
      expect(warn).not.toHaveBeenCalled();
    });

    it('without buffering, pre-init calls stay warn-once no-ops', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fake = createFakeFaro();
      captureException(new Error('dropped'));
      setFaroInstance(fake.faro);
      expect(fake.api.pushError).not.toHaveBeenCalled(); // dropped, not buffered
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('before init()'));
    });
  });
});
