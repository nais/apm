import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ApmErrorBoundary, withApmErrorBoundary } from './ErrorBoundary.js';

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../api.js', () => ({ captureException }));

function Boom(): never {
  throw new Error('kaboom');
}

/** React logs caught render errors to console.error; silence it per test. */
function silenceReactError(): void {
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

afterEach(() => {
  cleanup();
  captureException.mockClear();
});

describe('ApmErrorBoundary', () => {
  it('catches a throwing child, renders the fallback, and captures exactly once with the fingerprint', () => {
    silenceReactError();
    render(
      <ApmErrorBoundary fingerprint="render-error-1" fallback={<div>fell back</div>}>
        <Boom />
      </ApmErrorBoundary>
    );

    expect(screen.getByText('fell back')).toBeTruthy();
    expect(captureException).toHaveBeenCalledTimes(1);
    const [error, options] = captureException.mock.calls[0]!;
    expect((error as Error).message).toContain('kaboom');
    expect(options).toMatchObject({ fingerprint: 'render-error-1' });
  });

  it('supports a function fingerprint derived from the caught error', () => {
    silenceReactError();
    render(
      <ApmErrorBoundary fingerprint={(e) => `fp-${e.name}`}>
        <Boom />
      </ApmErrorBoundary>
    );
    const [, options] = captureException.mock.calls[0]!;
    // errorWithComponentStack renames to "React ErrorBoundary Error"
    expect(options.fingerprint).toBe('fp-React ErrorBoundary Error');
  });

  it('renders a default alert fallback when none is provided', () => {
    silenceReactError();
    render(
      <ApmErrorBoundary>
        <Boom />
      </ApmErrorBoundary>
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('passes context through to captureException', () => {
    silenceReactError();
    render(
      <ApmErrorBoundary context={{ feature: 'checkout' }}>
        <Boom />
      </ApmErrorBoundary>
    );
    const [, options] = captureException.mock.calls[0]!;
    expect(options.context).toEqual({ feature: 'checkout' });
  });

  it('render-prop fallback receives error and a working resetError', () => {
    silenceReactError();
    render(
      <ApmErrorBoundary
        fallback={(error, reset) => (
          <div>
            <span>caught: {error.message}</span>
            <button onClick={reset}>reset</button>
          </div>
        )}
      >
        <Boom />
      </ApmErrorBoundary>
    );
    expect(screen.getByText(/caught: kaboom/)).toBeTruthy();
    // resetError clears the error state (the child throws again, but this proves
    // the reset path runs without crashing the test renderer).
    expect(() => fireEvent.click(screen.getByText('reset'))).not.toThrow();
  });

  it('renders children unchanged when nothing throws', () => {
    render(
      <ApmErrorBoundary>
        <div>all good</div>
      </ApmErrorBoundary>
    );
    expect(screen.getByText('all good')).toBeTruthy();
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe('withApmErrorBoundary', () => {
  it('wraps a component and captures its render errors', () => {
    silenceReactError();
    const Wrapped = withApmErrorBoundary(Boom, { fingerprint: 'hoc-1' });
    render(<Wrapped />);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]![1].fingerprint).toBe('hoc-1');
  });

  it('sets a helpful displayName', () => {
    const Named = (): null => null;
    const Wrapped = withApmErrorBoundary(Named);
    expect(Wrapped.displayName).toBe('withApmErrorBoundary(Named)');
  });
});
