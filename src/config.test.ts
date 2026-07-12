import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetDevModeWarning,
  fromNaisConfig,
  isLocalHost,
  navTenant,
  resolveConfig,
  versionFromImage,
} from './config.js';

function addMeta(name: string, content: string): void {
  const meta = document.createElement('meta');
  meta.setAttribute('name', name);
  meta.setAttribute('content', content);
  document.head.appendChild(meta);
}

describe('resolveConfig', () => {
  beforeEach(() => {
    _resetDevModeWarning();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    document.head.querySelectorAll('meta').forEach((meta) => meta.remove());
  });

  it('resolves everything from nais meta tags', () => {
    addMeta('nais-app', 'soknad-dagpenger');
    addMeta('nais-team', 'dagpenger');
    addMeta('nais-cluster', 'prod-gcp');
    addMeta('nais-version', '2026.07.03-abc1234');
    addMeta('nais-telemetry-url', 'https://telemetry.nav.no/collect');

    const config = resolveConfig();
    expect(config).toEqual({
      app: 'soknad-dagpenger',
      namespace: 'dagpenger',
      environment: 'prod-gcp',
      version: '2026.07.03-abc1234',
      telemetryUrl: 'https://telemetry.nav.no/collect',
      devMode: false,
    });
  });

  it('prefers explicit init options over meta tags', () => {
    addMeta('nais-app', 'meta-app');
    addMeta('nais-telemetry-url', 'https://meta.example/collect');

    const config = resolveConfig({
      app: 'explicit-app',
      telemetryUrl: 'https://explicit.example/collect',
    });
    expect(config.app).toBe('explicit-app');
    expect(config.telemetryUrl).toBe('https://explicit.example/collect');
  });

  it('falls back to build-time NAIS_* env vars', () => {
    // GITHUB_SHA is a real ambient env var set by every GitHub Actions job
    // (unset locally, always present in CI). It must be cleared here so this
    // test actually exercises the image-tag fallback instead of incidentally
    // asserting on whatever commit CI happens to be running — see the
    // dedicated "prefers GITHUB_SHA" test below for that precedence.
    vi.stubEnv('GITHUB_SHA', '');
    vi.stubEnv('NAIS_APP_NAME', 'env-app');
    vi.stubEnv('NAIS_CLUSTER_NAME', 'dev-gcp');
    vi.stubEnv('NAIS_APP_IMAGE', 'europe-north1-docker.pkg.dev/nais/env-app:1.2.3-cafebabe');

    const config = resolveConfig();
    expect(config.app).toBe('env-app');
    expect(config.environment).toBe('dev-gcp');
    expect(config.version).toBe('1.2.3-cafebabe');
  });

  it('meta tags win over env vars', () => {
    vi.stubEnv('NAIS_APP_NAME', 'env-app');
    addMeta('nais-app', 'meta-app');
    expect(resolveConfig().app).toBe('meta-app');
  });

  it('prefers GITHUB_SHA over the image tag for the version (release identity, #64)', () => {
    vi.stubEnv('GITHUB_SHA', 'abc1234def5678');
    vi.stubEnv('NAIS_APP_IMAGE', 'europe-north1-docker.pkg.dev/nais/env-app:1.2.3-cafebabe');
    expect(resolveConfig({ app: 'a', environment: 'dev-gcp' }).version).toBe('abc1234def5678');
  });

  it('derives the well-known collector from the cluster name', () => {
    expect(resolveConfig({ app: 'a', environment: 'prod-gcp' }).telemetryUrl).toBe(
      'https://telemetry.nav.no/collect'
    );
    expect(resolveConfig({ app: 'a', environment: 'dev-gcp' }).telemetryUrl).toBe(
      'https://telemetry.ekstern.dev.nav.no/collect'
    );
  });

  it('enters dev mode and warns once when no collector resolves', () => {
    // Provide a namespace so this test isolates the dev-mode warning from the
    // separate missing-namespace warning.
    const first = resolveConfig({ namespace: 'team-x' });
    const second = resolveConfig({ namespace: 'team-x' });
    expect(first.devMode).toBe(true);
    expect(first.app).toBe('unknown-app');
    expect(second.devMode).toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('dev mode');
  });

  it('ignores empty meta tag content', () => {
    addMeta('nais-app', '');
    vi.stubEnv('NAIS_APP_NAME', 'env-app');
    expect(resolveConfig().app).toBe('env-app');
  });

  it('resolves the collector from NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL (naiserator, SSR)', () => {
    vi.stubEnv('NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL', 'https://telemetry.tenant.example/collect');
    const config = resolveConfig({ app: 'a', namespace: 't' });
    expect(config.telemetryUrl).toBe('https://telemetry.tenant.example/collect');
    expect(config.devMode).toBe(false);
  });

  it('meta tag wins over NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL', () => {
    vi.stubEnv('NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL', 'https://env.example/collect');
    addMeta('nais-telemetry-url', 'https://meta.example/collect');
    expect(resolveConfig({ app: 'a', namespace: 't' }).telemetryUrl).toBe(
      'https://meta.example/collect'
    );
  });

  it('prints the per-field resolution table with debug: true', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    addMeta('nais-team', 'dagpenger');
    resolveConfig({ app: 'my-app', telemetryUrl: 'https://x.example/collect', debug: true });
    expect(info).toHaveBeenCalledTimes(1);
    const table = String(info.mock.calls[0]?.[0]);
    expect(table).toContain('app = my-app ← init option');
    expect(table).toContain('namespace = dagpenger ← meta nais-team');
    expect(table).toContain('telemetryUrl = https://x.example/collect ← init option');
    expect(table).toContain('mode = sending');
  });
});

describe('fromNaisConfig', () => {
  it('maps the naiserator generatedConfig payload to init options', () => {
    expect(
      fromNaisConfig({
        schemaVersion: 1,
        telemetryCollectorURL: 'https://telemetry.nav.no/collect',
        app: { name: 'my-app', namespace: 'my-team', version: '2026.07.12-abc1234' },
        environment: 'prod-gcp',
      })
    ).toEqual({
      app: 'my-app',
      namespace: 'my-team',
      version: '2026.07.12-abc1234',
      environment: 'prod-gcp',
      telemetryUrl: 'https://telemetry.nav.no/collect',
    });
  });

  it("maps today's payload (no namespace/environment/schemaVersion yet, #134)", () => {
    expect(
      fromNaisConfig({
        telemetryCollectorURL: 'https://telemetry.nav.no/collect',
        app: { name: 'my-app', version: '1.2.3' },
      })
    ).toEqual({
      app: 'my-app',
      version: '1.2.3',
      telemetryUrl: 'https://telemetry.nav.no/collect',
    });
  });

  it('tolerates null, undefined, and junk', () => {
    expect(fromNaisConfig(null)).toEqual({});
    expect(fromNaisConfig(undefined)).toEqual({});
    expect(fromNaisConfig('nonsense' as never)).toEqual({});
    expect(fromNaisConfig({ app: {} })).toEqual({});
  });
});

describe('navTenant profile', () => {
  it('maps prod hostnames to the prod collector', () => {
    for (const host of ['nav.no', 'www.nav.no', 'myapp.intern.nav.no', 'myapp.ansatt.nav.no']) {
      expect(navTenant.telemetryUrlFromHostname?.(host)).toBe('https://telemetry.nav.no/collect');
    }
  });

  it('maps dev hostnames to the dev collector (dev checked before prod)', () => {
    for (const host of [
      'dev.nav.no',
      'myapp.ekstern.dev.nav.no',
      'myapp.intern.dev.nav.no',
      'myapp.ansatt.dev.nav.no',
    ]) {
      expect(navTenant.telemetryUrlFromHostname?.(host)).toBe(
        'https://telemetry.ekstern.dev.nav.no/collect'
      );
    }
  });

  it('does not match non-nav or lookalike hosts', () => {
    for (const host of ['example.com', 'evil-nav.no.example.com', 'notnav.no.evil.io', 'xnav.no']) {
      expect(navTenant.telemetryUrlFromHostname?.(host)).toBeUndefined();
    }
  });

  it('maps cluster names as before', () => {
    expect(navTenant.telemetryUrlFromCluster?.('prod-gcp')).toBe(
      'https://telemetry.nav.no/collect'
    );
    expect(navTenant.telemetryUrlFromCluster?.('dev-fss')).toBe(
      'https://telemetry.ekstern.dev.nav.no/collect'
    );
    expect(navTenant.telemetryUrlFromCluster?.('ci')).toBeUndefined();
  });
});

describe('isLocalHost', () => {
  it('treats local hosts as local', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'myapp.localhost', 'dev.local', '']) {
      expect(isLocalHost(host)).toBe(true);
    }
  });

  it('treats real hosts as non-local', () => {
    for (const host of ['www.nav.no', 'app.intern.dev.nav.no', 'example.com']) {
      expect(isLocalHost(host)).toBe(false);
    }
  });

  it('treats a missing hostname (SSR / non-browser) as local', () => {
    expect(isLocalHost(undefined)).toBe(true);
  });

  it('defaults to the jsdom hostname (localhost) in this environment', () => {
    expect(isLocalHost()).toBe(true);
  });
});

describe('resolveConfig namespace (team)', () => {
  beforeEach(() => {
    _resetDevModeWarning();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    document.head.querySelectorAll('meta').forEach((meta) => meta.remove());
  });

  it('prefers the init option over meta and env', () => {
    addMeta('nais-team', 'meta-team');
    vi.stubEnv('NAIS_TEAM', 'env-team');
    expect(resolveConfig({ namespace: 'opt-team' }).namespace).toBe('opt-team');
  });

  it('resolves from the nais-team meta tag', () => {
    addMeta('nais-team', 'dagpenger');
    expect(resolveConfig().namespace).toBe('dagpenger');
  });

  it('accepts the nais-namespace meta tag as an alias', () => {
    addMeta('nais-namespace', 'pensjon');
    expect(resolveConfig().namespace).toBe('pensjon');
  });

  it('meta wins over the NAIS_TEAM env', () => {
    addMeta('nais-team', 'meta-team');
    vi.stubEnv('NAIS_TEAM', 'env-team');
    expect(resolveConfig().namespace).toBe('meta-team');
  });

  it('falls back to the NAIS_TEAM / NAIS_NAMESPACE env', () => {
    vi.stubEnv('NAIS_NAMESPACE', 'aap');
    expect(resolveConfig().namespace).toBe('aap');
  });

  it('loud-errors (prod) and falls back to unknown-team when unresolved', () => {
    const config = resolveConfig({ app: 'a', environment: 'prod-gcp' });
    expect(config.namespace).toBe('unknown-team');
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0]?.[0]).toContain('namespace (team) is required');
  });

  it('warns instead of errors in dev mode when unresolved', () => {
    const config = resolveConfig({ app: 'a' }); // no collector → dev mode
    expect(config.namespace).toBe('unknown-team');
    expect(console.error).not.toHaveBeenCalled();
    expect(
      vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('namespace (team) is required'))
    ).toBe(true);
  });
});

describe('versionFromImage', () => {
  it('extracts the tag', () => {
    expect(versionFromImage('ghcr.io/navikt/app:2026.07.03-abc1234')).toBe('2026.07.03-abc1234');
  });

  it('handles registry ports without a tag', () => {
    expect(versionFromImage('registry.local:5000/navikt/app')).toBeUndefined();
  });

  it('handles registry ports with a tag', () => {
    expect(versionFromImage('registry.local:5000/navikt/app:v1')).toBe('v1');
  });

  it('returns undefined for untagged or empty input', () => {
    expect(versionFromImage('ghcr.io/navikt/app')).toBeUndefined();
    expect(versionFromImage(undefined)).toBeUndefined();
  });
});
