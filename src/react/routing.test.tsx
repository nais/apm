import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { EVENT_ROUTE_CHANGE } from '@grafana/faro-web-sdk';

import { enableApmReactRouterV6, useApmRouteTracking } from './routing.js';

const { getFaroInstance } = vi.hoisted(() => ({ getFaroInstance: vi.fn() }));
vi.mock('../internal.js', () => ({ getFaroInstance }));

afterEach(() => {
  cleanup();
  getFaroInstance.mockReset();
});

describe('useApmRouteTracking (Next.js App Router)', () => {
  function Harness({ path, search }: { path: string; search?: string }): ReactElement {
    useApmRouteTracking(path, search);
    return <div>{path}</div>;
  }

  it('pushes exactly one route-change event per pathname change', () => {
    const pushEvent = vi.fn();
    getFaroInstance.mockReturnValue({ api: { pushEvent } });

    const { rerender } = render(<Harness path="/a" />);
    expect(pushEvent).toHaveBeenCalledTimes(1);
    expect(pushEvent.mock.calls[0]![0]).toBe(EVENT_ROUTE_CHANGE);
    expect(pushEvent.mock.calls[0]![1]).toMatchObject({ toRoute: '/a', toUrl: '/a' });

    // Same path re-render: no new event.
    rerender(<Harness path="/a" />);
    expect(pushEvent).toHaveBeenCalledTimes(1);

    // New path: one more event, carrying fromUrl.
    rerender(<Harness path="/b" />);
    expect(pushEvent).toHaveBeenCalledTimes(2);
    expect(pushEvent.mock.calls[1]![1]).toMatchObject({
      toUrl: '/b',
      fromUrl: '/a',
    });
  });

  it('includes the search string in toUrl and dedupes on it', () => {
    const pushEvent = vi.fn();
    getFaroInstance.mockReturnValue({ api: { pushEvent } });

    const { rerender } = render(<Harness path="/x" search="q=1" />);
    expect(pushEvent.mock.calls[0]![1]).toMatchObject({ toRoute: '/x', toUrl: '/x?q=1' });

    rerender(<Harness path="/x" search="q=1" />);
    expect(pushEvent).toHaveBeenCalledTimes(1);

    rerender(<Harness path="/x" search="q=2" />);
    expect(pushEvent).toHaveBeenCalledTimes(2);
    expect(pushEvent.mock.calls[1]![1].toUrl).toBe('/x?q=2');
  });

  it('is a safe no-op before init()', () => {
    getFaroInstance.mockReturnValue(undefined);
    expect(() => render(<Harness path="/a" />)).not.toThrow();
  });
});

describe('enableApmReactRouterV6', () => {
  const deps = {
    createRoutesFromChildren: () => [],
    matchRoutes: () => null,
    Routes: () => null,
    useLocation: () => ({ pathname: '/', search: '', hash: '', state: null, key: 'x' }),
    useNavigationType: () => 'POP',
  } as never;

  it('late-adds faro-react ReactIntegration wired for v6', () => {
    const add = vi.fn();
    getFaroInstance.mockReturnValue({ instrumentations: { add } });

    enableApmReactRouterV6(deps);

    expect(add).toHaveBeenCalledTimes(1);
    const added = add.mock.calls[0]![0] as { name: string };
    expect(added.name).toBe('@grafana/faro-react');
  });

  it('no-ops when faro is not initialized', () => {
    getFaroInstance.mockReturnValue(undefined);
    expect(() => enableApmReactRouterV6(deps)).not.toThrow();
  });
});
