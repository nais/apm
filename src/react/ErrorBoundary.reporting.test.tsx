/**
 * Regression test for nais/apm#36: a render error caught by ApmErrorBoundary
 * must reach the transport EXACTLY ONCE.
 *
 * React 19's default `onCaughtError` logs every caught error with
 * `console.error` (dev and prod builds alike). `NaisConsoleInstrumentation`
 * patches `console.error`, so without deduplication the same render error is
 * transported twice: once from the console patch, once from
 * `componentDidCatch` → `captureException`.
 *
 * Unlike ErrorBoundary.test.tsx this file mocks nothing: real `init()`, real
 * React 19 root render, and the count is taken at the `beforeSend` choke point
 * every capture path routes through.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TransportItemType } from '@grafana/faro-web-sdk';
import type { ExceptionEvent, TransportItem } from '@grafana/faro-web-sdk';

import { init } from '../index.js';
import { _resetStateForTesting } from '../internal.js';
import { ApmErrorBoundary } from './ErrorBoundary.js';

function Boom(): never {
  throw new Error('kaboom');
}

afterEach(() => {
  cleanup();
  _resetStateForTesting();
  vi.restoreAllMocks();
});

/**
 * The console spies MUST be installed before `init()`: the instrumentation
 * wraps whatever `console.error` is at initialize() time, so spying afterwards
 * would replace the patch and the console capture path would never run.
 */
function initWithExceptionCounter(): ExceptionEvent[] {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  const exceptions: ExceptionEvent[] = [];
  init({
    namespace: 'team',
    environment: 'local',
    telemetryUrl: undefined,
    // isolate: keep the instance off Faro's global registry; batching off so
    // beforeSend runs once per item, synchronously.
    faro: { isolate: true, batching: { enabled: false } },
    beforeSend: (item: TransportItem) => {
      if (item.type === TransportItemType.EXCEPTION) {
        exceptions.push(item.payload as ExceptionEvent);
      }
      return item;
    },
  });
  return exceptions;
}

describe('ApmErrorBoundary reporting (real React 19 root)', () => {
  it('transports a caught render error exactly once', () => {
    const exceptions = initWithExceptionCounter();

    render(
      <ApmErrorBoundary fingerprint="render-error-36">
        <Boom />
      </ApmErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(exceptions.map((e) => e.value)).toHaveLength(1);
    // The surviving report is the boundary's, not the console one: it carries
    // the fingerprint and the component stack.
    expect(exceptions[0]?.context?.['fingerprint']).toBe('render-error-36');
    expect(exceptions[0]?.type).toContain('React ErrorBoundary');
  });

  it('still captures ordinary console.error calls', () => {
    const exceptions = initWithExceptionCounter();

    console.error('plain failure', new Error('not from a boundary'));

    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.value).toBe('not from a boundary');
  });
});
