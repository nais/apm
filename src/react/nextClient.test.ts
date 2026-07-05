import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetStateForTesting, isInitialized } from '../internal.js';
import { initNaisAPMClient } from './nextClient.js';

const browserOpts = { namespace: 't', environment: 'local', telemetryUrl: undefined } as const;

describe('initNaisAPMClient', () => {
  beforeEach(() => {
    _resetStateForTesting();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => _resetStateForTesting());

  it('initializes in the browser and is idempotent under repeated / StrictMode double invoke', () => {
    const first = initNaisAPMClient({ ...browserOpts });
    const second = initNaisAPMClient({ ...browserOpts });
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('no-ops on the server (typeof window === "undefined") without initializing', () => {
    vi.stubGlobal('window', undefined);
    const result = initNaisAPMClient({ ...browserOpts });
    expect(result).toBeUndefined();
    // still not initialized after a server-side call
    expect(isInitialized()).toBe(false);
  });
});
