import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getNaisMetaTags, renderNaisMetaTags } from './metaTags.js';

describe('getNaisMetaTags', () => {
  beforeEach(() => {
    // vitest's unstubEnvs restores these after each test.
    vi.stubEnv('NAIS_APP_NAME', 'pod-app');
    vi.stubEnv('NAIS_NAMESPACE', 'pod-team');
    vi.stubEnv('NAIS_CLUSTER_NAME', 'prod-gcp');
    vi.stubEnv('NAIS_APP_IMAGE', 'europe-north1-docker.pkg.dev/nais/pod-app:2026.07.12-abc1234');
    vi.stubEnv('NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL', 'https://telemetry.nav.no/collect');
  });

  it('renders all five tags from the pod runtime env', () => {
    expect(getNaisMetaTags()).toEqual([
      { name: 'nais-app', content: 'pod-app' },
      { name: 'nais-team', content: 'pod-team' },
      { name: 'nais-cluster', content: 'prod-gcp' },
      { name: 'nais-version', content: '2026.07.12-abc1234' },
      { name: 'nais-telemetry-url', content: 'https://telemetry.nav.no/collect' },
    ]);
  });

  it('prefers NAIS_TEAM over NAIS_NAMESPACE', () => {
    vi.stubEnv('NAIS_TEAM', 'the-team');
    expect(getNaisMetaTags().find((t) => t.name === 'nais-team')?.content).toBe('the-team');
  });

  it('explicit overrides win over env', () => {
    const tags = getNaisMetaTags({ app: 'explicit', telemetryUrl: 'https://x.example/collect' });
    expect(tags.find((t) => t.name === 'nais-app')?.content).toBe('explicit');
    expect(tags.find((t) => t.name === 'nais-telemetry-url')?.content).toBe(
      'https://x.example/collect'
    );
  });

  it('the generatedConfig payload wins over env but loses to overrides', () => {
    const tags = getNaisMetaTags(
      { app: 'explicit' },
      {
        schemaVersion: 1,
        telemetryCollectorURL: 'https://cfg.example/collect',
        app: { name: 'cfg-app', namespace: 'cfg-team', version: '9.9.9' },
        environment: 'dev-gcp',
      }
    );
    expect(tags).toEqual([
      { name: 'nais-app', content: 'explicit' },
      { name: 'nais-team', content: 'cfg-team' },
      { name: 'nais-cluster', content: 'dev-gcp' },
      { name: 'nais-version', content: '9.9.9' },
      { name: 'nais-telemetry-url', content: 'https://cfg.example/collect' },
    ]);
  });

  it('omits unresolved fields instead of rendering empty tags', () => {
    vi.stubEnv('NAIS_APP_NAME', '');
    vi.stubEnv('NAIS_APP_IMAGE', '');
    const names = getNaisMetaTags().map((t) => t.name);
    expect(names).not.toContain('nais-app');
    expect(names).not.toContain('nais-version');
    expect(names).toContain('nais-team');
  });
});

describe('renderNaisMetaTags', () => {
  it('renders HTML with escaped attribute values', () => {
    const html = renderNaisMetaTags({
      app: 'a"b<c>&d',
      namespace: 't',
      environment: 'e',
      version: 'v',
      telemetryUrl: 'https://x.example/collect',
    });
    expect(html).toContain('<meta name="nais-app" content="a&quot;b&lt;c&gt;&amp;d">');
    expect(html.split('\n')).toHaveLength(5);
  });
});
