/**
 * Route-change tracking for @nais/apm (nais/grafana-apm-app#79).
 *
 * Two supported routers:
 *   - React Router v6 (web): faro-react's `FaroRoutes`, re-exported as
 *     `ApmRoutes`, wired via {@link enableApmReactRouterV6} which injects the
 *     app's own react-router dependencies. We do NOT import react-router
 *     ourselves — it stays an optional peer, avoiding version drift.
 *   - Next.js App Router: {@link useApmRouteTracking}, our own small hook (no
 *     faro-react App Router integration exists). Pushes a Faro route-change
 *     event per pathname change.
 *
 * v5/v7 and the data-router variants are out of scope for 0.2.0 (follow-ups).
 */

import { useEffect, useRef } from 'react';
import {
  FaroRoutes,
  ReactIntegration,
  createReactRouterV6Options,
} from '@grafana/faro-react';
import type { ReactRouterV6Dependencies } from '@grafana/faro-react';
import { EVENT_ROUTE_CHANGE } from '@grafana/faro-web-sdk';

import { getFaroInstance } from '../internal.js';

/** Drop-in for react-router's `<Routes>` that reports route changes. */
export { FaroRoutes as ApmRoutes };
export type { ReactRouterV6Dependencies } from '@grafana/faro-react';

/**
 * Enable React Router v6 route-change tracking. Call once after `init()`,
 * passing your app's own react-router-dom exports:
 *
 * ```ts
 * import { createRoutesFromChildren, matchRoutes, Routes, useLocation, useNavigationType } from 'react-router-dom';
 * enableApmReactRouterV6({ createRoutesFromChildren, matchRoutes, Routes, useLocation, useNavigationType });
 * ```
 *
 * Then render `<ApmRoutes>` where you would render `<Routes>`. Late-adds
 * faro-react's `ReactIntegration` (OpenTelemetry-free) wired for v6.
 */
export function enableApmReactRouterV6(dependencies: ReactRouterV6Dependencies): void {
  const faro = getFaroInstance();
  if (!faro) {
    return;
  }
  faro.instrumentations.add(
    new ReactIntegration({
      router: createReactRouterV6Options(dependencies),
    }) as never
  );
}

/**
 * Track route changes in a Next.js App Router app. There is no faro-react
 * integration for the App Router, so this is our own hook: it pushes a Faro
 * route-change event whenever the pathname (or search) changes.
 *
 * Call it in a client component with Next's navigation hooks:
 *
 * ```tsx
 * 'use client';
 * import { usePathname, useSearchParams } from 'next/navigation';
 * import { useApmRouteTracking } from '@nais/apm/react';
 *
 * export function ApmRouteTracker() {
 *   useApmRouteTracking(usePathname(), useSearchParams());
 *   return null;
 * }
 * ```
 *
 * Passing the values in (rather than importing `next/navigation` here) keeps
 * Next out of this package's dependency tree and makes the hook usable with any
 * router that can supply a pathname.
 */
export function useApmRouteTracking(
  pathname: string | null | undefined,
  searchParams?: URLSearchParams | string | null
): void {
  const search =
    searchParams == null
      ? ''
      : typeof searchParams === 'string'
        ? searchParams
        : searchParams.toString();
  const url = pathname == null ? null : search ? `${pathname}?${search}` : pathname;
  const previousUrl = useRef<string | null>(null);

  useEffect(() => {
    if (url == null || previousUrl.current === url) {
      return;
    }
    const fromUrl = previousUrl.current;
    previousUrl.current = url;

    const faro = getFaroInstance();
    if (!faro) {
      return;
    }
    faro.api.pushEvent(EVENT_ROUTE_CHANGE, {
      toRoute: pathname ?? url,
      toUrl: url,
      ...(fromUrl ? { fromUrl } : {}),
    });
  }, [url, pathname]);
}
