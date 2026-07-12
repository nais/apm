// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://myapp.intern.nav.no/" }
/**
 * The loud-failure path (ADR-0001 decision 6): this file pins jsdom to a real
 * (non-local) nais host, where a missing collector URL is a production
 * misconfiguration — a specific `console.error`, never silent dev mode.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDevModeWarning, isLocalHost, resolveConfig } from './config.js';

describe('resolveConfig on a non-local host', () => {
  beforeEach(() => {
    _resetDevModeWarning();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('is not a local host', () => {
    expect(isLocalHost()).toBe(false);
  });

  it('loud-errors (not warns) once when no collector resolves', () => {
    const first = resolveConfig({ app: 'a', namespace: 'team-x' });
    resolveConfig({ app: 'a', namespace: 'team-x' });

    expect(first.devMode).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(console.error).mock.calls[0]?.[0]);
    expect(message).toContain('telemetry will NOT be sent');
    expect(message).toContain('initFromConfigUrl');
    expect(message).toContain('debug: true');
  });

  it('loud-errors for a missing namespace even without a collector', () => {
    resolveConfig({ app: 'a' });
    expect(
      vi
        .mocked(console.error)
        .mock.calls.some((c) => String(c[0]).includes('namespace (team) is required'))
    ).toBe(true);
  });
});
