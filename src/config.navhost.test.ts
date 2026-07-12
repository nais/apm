// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://myapp.intern.nav.no/" }
/**
 * The interim nav-tenant hostname fallback (ADR-0001 decision 7): on a nav
 * domain with no other collector source, the collector is derived from the
 * page's hostname — this is what un-breaks bare init() in a static bundle
 * until the platform-served config URL ships (nais/grafana-apm-app#134).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetDevModeWarning, resolveConfig } from './config.js';

describe('resolveConfig on a nav host', () => {
  beforeEach(() => {
    _resetDevModeWarning();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('derives the prod collector from the hostname when nothing else resolves', () => {
    const config = resolveConfig({ app: 'a', namespace: 'team-x' });
    expect(config.telemetryUrl).toBe('https://telemetry.nav.no/collect');
    expect(config.devMode).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('every explicit source still wins over the hostname derivation', () => {
    expect(
      resolveConfig({ app: 'a', namespace: 't', telemetryUrl: 'https://x.example/collect' })
        .telemetryUrl
    ).toBe('https://x.example/collect');
    expect(resolveConfig({ app: 'a', namespace: 't', environment: 'dev-gcp' }).telemetryUrl).toBe(
      'https://telemetry.ekstern.dev.nav.no/collect'
    );
  });

  it('tenant: false disables derivation and loud-errors instead', () => {
    const config = resolveConfig({ app: 'a', namespace: 'team-x', tenant: false });
    expect(config.devMode).toBe(true);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toContain(
      'telemetry will NOT be sent'
    );
  });
});
