/**
 * React error boundary for @nais/apm (nais/grafana-apm-app#79).
 *
 * Why hand-rolled instead of wrapping faro-react's `FaroErrorBoundary`:
 * `FaroErrorBoundary.componentDidCatch` unconditionally calls `api.pushError`
 * itself. Routing a caught error through our `captureException` (to get the
 * SDK's fingerprint/context pipeline) on top of that would report the SAME
 * error twice. This boundary therefore owns the lifecycle and reports EXACTLY
 * ONCE through `captureException`, so a render error gets our fingerprint and
 * global context — and, as a bonus, the React entry stays free of faro-react's
 * non-tree-shakeable barrel.
 */

import { Component, isValidElement } from 'react';
import type { ComponentType, ErrorInfo, ReactElement, ReactNode } from 'react';

import { captureException } from '../api.js';

/** Render-prop fallback: receives the error and a reset callback. */
export type ApmErrorBoundaryFallbackRender = (
  error: Error,
  resetError: () => void
) => ReactNode;

export interface ApmErrorBoundaryProps {
  children?: ReactNode;
  /**
   * What to render once an error is caught. Either a React element/node, or a
   * render function `(error, resetError) => node`. Defaults to a minimal
   * `role="alert"` message.
   */
  fallback?: ReactNode | ApmErrorBoundaryFallbackRender;
  /**
   * Custom grouping key passed to `captureException` (mapped to
   * `context.fingerprint`). A function receives the caught error so grouping
   * can depend on it.
   */
  fingerprint?: string | ((error: Error) => string);
  /** Extra context merged into the captured exception. */
  context?: Record<string, unknown>;
  /** Called after the error has been captured. */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Called when the boundary is reset (via the render-prop `resetError`). */
  onReset?: (error: Error | null) => void;
}

interface ApmErrorBoundaryState {
  error: Error | null;
}

const defaultFallback: ReactElement = (
  <div role="alert">Something went wrong.</div>
);

/**
 * Attaches the React component stack to the reported error (mirrors what
 * faro-react does) so exception grouping keys off the component tree.
 */
function errorWithComponentStack(error: Error, errorInfo: ErrorInfo): Error {
  const componentStack = errorInfo.componentStack;
  if (!componentStack) {
    return error;
  }
  const withStack = new Error(error.message);
  withStack.name = `React ErrorBoundary ${error.name}`;
  withStack.stack = componentStack;
  return withStack;
}

/**
 * Catches render errors in the subtree, reports them once through
 * `captureException`, and renders a fallback. Sentry-compatible shape.
 */
export class ApmErrorBoundary extends Component<
  ApmErrorBoundaryProps,
  ApmErrorBoundaryState
> {
  override state: ApmErrorBoundaryState = { error: null };

  constructor(props: ApmErrorBoundaryProps) {
    super(props);
    this.resetErrorBoundary = this.resetErrorBoundary.bind(this);
  }

  static getDerivedStateFromError(error: Error): ApmErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const reported = errorWithComponentStack(error, errorInfo);
    const { fingerprint } = this.props;
    const resolvedFingerprint =
      typeof fingerprint === 'function' ? fingerprint(reported) : fingerprint;
    // Single capture — routes through the SDK's fingerprint/context pipeline.
    captureException(reported, {
      context: this.props.context,
      fingerprint: resolvedFingerprint,
    });
    this.props.onError?.(reported, errorInfo);
  }

  resetErrorBoundary(): void {
    const { error } = this.state;
    this.props.onReset?.(error);
    this.setState({ error: null });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    const { fallback } = this.props;
    if (fallback === undefined) {
      return defaultFallback;
    }
    const element =
      typeof fallback === 'function'
        ? (fallback as ApmErrorBoundaryFallbackRender)(error, this.resetErrorBoundary)
        : fallback;
    return isValidElement(element) ? element : defaultFallback;
  }
}

/**
 * HOC that wraps a component in an {@link ApmErrorBoundary}. Sentry-compatible
 * `withErrorBoundary` shape.
 */
export function withApmErrorBoundary<P extends object>(
  WrappedComponent: ComponentType<P>,
  errorBoundaryProps: ApmErrorBoundaryProps = {}
): ComponentType<P> {
  const Wrapper = (props: P): ReactElement => (
    <ApmErrorBoundary {...errorBoundaryProps}>
      <WrappedComponent {...props} />
    </ApmErrorBoundary>
  );
  const name =
    WrappedComponent.displayName ?? WrappedComponent.name ?? 'Component';
  Wrapper.displayName = `withApmErrorBoundary(${name})`;
  return Wrapper;
}
