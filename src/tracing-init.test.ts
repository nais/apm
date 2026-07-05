/**
 * init()-level lazy-load contract: tracing.js is only pulled in (and
 * startTracing only called) when `tracing` is truthy. The dynamic import is
 * mocked so the assertion does not depend on the real OpenTelemetry tree.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { _resetStateForTesting } from './internal.js';

const { startTracing } = vi.hoisted(() => ({ startTracing: vi.fn() }));
vi.mock('./tracing.js', () => ({ startTracing }));

const baseOpts = { namespace: 'team', environment: 'local', telemetryUrl: undefined } as const;

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('init() tracing lazy-load', () => {
  afterEach(() => {
    _resetStateForTesting();
    startTracing.mockClear();
  });

  it('does not load tracing when the option is absent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { init } = await import('./index.js');
    init({ ...baseOpts });
    await flushMicrotasks();
    expect(startTracing).not.toHaveBeenCalled();
  });

  it('does not load tracing when tracing is false', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { init } = await import('./index.js');
    init({ ...baseOpts, tracing: false });
    await flushMicrotasks();
    expect(startTracing).not.toHaveBeenCalled();
  });

  it('lazy-loads and starts tracing when tracing: true', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { init } = await import('./index.js');
    const faro = init({ ...baseOpts, tracing: true });
    await flushMicrotasks();
    expect(startTracing).toHaveBeenCalledTimes(1);
    expect(startTracing.mock.calls[0]![0]).toBe(faro);
    expect(startTracing.mock.calls[0]![1]).toEqual({ propagateExtraOrigins: undefined });
  });

  it('forwards propagateExtraOrigins from the object form', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { init } = await import('./index.js');
    init({ ...baseOpts, tracing: { propagateExtraOrigins: ['https://extra.nav.no'] } });
    await flushMicrotasks();
    expect(startTracing).toHaveBeenCalledTimes(1);
    expect(startTracing.mock.calls[0]![1]).toEqual({
      propagateExtraOrigins: ['https://extra.nav.no'],
    });
  });
});
