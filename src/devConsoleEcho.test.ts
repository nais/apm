/**
 * init()-level dev-mode transport contract: with no collector resolved the
 * ConsoleTransport echoes everything by default, and `devConsoleEcho: false`
 * silences both the echo (no transports at all) and the once-only dev-mode
 * notice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { _resetDevModeWarning } from './config.js';
import { _resetStateForTesting } from './internal.js';

// Local host (jsdom serves from localhost) + no collector → dev mode.
// `isolate: true` keeps each test's Faro instance off the global registry so
// the second/third init() in this file does not hit Faro's already-registered
// guard (which returns undefined).
const baseOpts = {
  namespace: 'team',
  environment: 'local',
  telemetryUrl: undefined,
  faro: { isolate: true },
} as const;

describe('init() devConsoleEcho', () => {
  afterEach(() => {
    _resetStateForTesting();
    _resetDevModeWarning();
    vi.restoreAllMocks();
  });

  it('echoes to the console by default in dev mode (and warns once)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { init } = await import('./index.js');
    const faro = init({ ...baseOpts });
    expect(faro.transports.transports).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dev mode'));
  });

  it('installs no transports and skips the dev-mode notice with devConsoleEcho: false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { init } = await import('./index.js');
    const faro = init({ ...baseOpts, devConsoleEcho: false });
    expect(faro.transports.transports).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('has no effect when a collector is resolved', async () => {
    const { init } = await import('./index.js');
    const faro = init({
      ...baseOpts,
      telemetryUrl: 'https://telemetry.example/collect',
      devConsoleEcho: false,
    });
    expect(faro.transports.transports).toHaveLength(1);
    expect(faro.transports.transports[0]?.constructor.name).toBe('FetchTransport');
  });
});
