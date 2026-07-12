/**
 * Integration test for initFromConfigUrl: fetches the served naiserator
 * generatedConfig payload (nais.json), fills unset init options from it, and
 * buffers signals raised while the fetch is in flight. Faro is a per-isolate
 * singleton, so this lives in its own file (fresh jsdom per file).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Faro } from '@grafana/faro-web-sdk';

import { captureException, initFromConfigUrl } from './index.js';
import { _resetStateForTesting } from './internal.js';

const NAIS_JSON = {
  schemaVersion: 1,
  // No telemetryCollectorURL on purpose: keeps init in console-echo dev mode
  // so the test exercises resolution without a network transport.
  app: { name: 'cfg-app', namespace: 'cfg-team', version: '3.2.1' },
  environment: 'dev-local',
};

describe('initFromConfigUrl()', () => {
  let faro: Faro;
  let pendingError: Error;
  // Kept as a reference: `unstubGlobals: true` restores the global between
  // tests, so assertions must target the mock itself, not global fetch.
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => NAIS_JSON,
  }));

  beforeAll(async () => {
    _resetStateForTesting();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    const promise = initFromConfigUrl('/nais.json', { app: 'explicit-app' });
    // Raised while the config fetch is in flight — must be buffered, not lost.
    pendingError = new Error('early bird');
    captureException(pendingError);

    faro = await promise;
  });

  it('fetches the given URL', () => {
    expect(fetchMock).toHaveBeenCalledWith('/nais.json');
  });

  it('fills unset fields from the fetched payload', () => {
    expect(faro.metas.value.app?.namespace).toBe('cfg-team');
    expect(faro.metas.value.app?.version).toBe('3.2.1');
    expect(faro.metas.value.app?.environment).toBe('dev-local');
  });

  it('explicit init options win over fetched values', () => {
    expect(faro.metas.value.app?.name).toBe('explicit-app');
  });

  it('returns the existing instance (with a warning) when already initialized', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = await initFromConfigUrl('/nais.json');
    expect(second).toBe(faro);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('more than once'));
  });
});
