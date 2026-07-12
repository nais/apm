/**
 * initFromConfigUrl failure path: a failed config fetch must never block or
 * throw — initialization proceeds with standard resolution (which is loud
 * about anything missing). Own file: Faro is a per-isolate singleton.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Faro } from '@grafana/faro-web-sdk';

import { initFromConfigUrl } from './index.js';
import { _resetStateForTesting, isInitialized } from './internal.js';

describe('initFromConfigUrl() with a failing fetch', () => {
  let faro: Faro;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    _resetStateForTesting();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      })
    );

    faro = await initFromConfigUrl('/nais.json', { app: 'my-app', namespace: 'my-team' });
  });

  it('still initializes (dev mode on localhost) instead of throwing', () => {
    expect(isInitialized()).toBe(true);
    expect(faro.metas.value.app?.name).toBe('my-app');
    expect(faro.metas.value.app?.namespace).toBe('my-team');
  });

  it('warns specifically about the failed fetch', () => {
    expect(
      warn.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes("Fetching nais config from '/nais.json'")
      )
    ).toBe(true);
  });
});
