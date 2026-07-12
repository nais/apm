/**
 * `@nais/apm/react` — React entry point (nais/grafana-apm-app#79).
 *
 * Opt-in helpers for React apps: an error boundary that reports through the
 * SDK's `captureException` pipeline, route-change tracking for React Router v6
 * and the Next.js App Router, and a Next.js client-init helper. React and
 * react-router are optional peer dependencies — importing this entry requires
 * them (and `@grafana/faro-react` for the v6 route wiring).
 */

export { ApmErrorBoundary, withApmErrorBoundary } from './ErrorBoundary.js';
export type {
  ApmErrorBoundaryProps,
  ApmErrorBoundaryFallbackRender,
} from './ErrorBoundary.js';

export { ApmRoutes, enableApmReactRouterV6, useApmRouteTracking } from './routing.js';
export type { ReactRouterV6Dependencies } from './routing.js';

export { initNaisAPMClient } from './nextClient.js';

export { NaisMetaTags } from './NaisMetaTags.js';
export type { NaisMetaTagsProps } from './NaisMetaTags.js';
