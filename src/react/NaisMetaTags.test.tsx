import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { NaisMetaTags } from './NaisMetaTags.js';

// React 19 hoists <meta> elements into document.head, so assertions query the
// document rather than the render container.
function metaContent(name: string): string | null | undefined {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('meta').forEach((meta) => meta.remove());
});

describe('<NaisMetaTags />', () => {
  it('renders meta elements from the runtime env', () => {
    vi.stubEnv('NAIS_APP_NAME', 'ssr-app');
    vi.stubEnv('NAIS_TEAM', 'ssr-team');
    vi.stubEnv('NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL', 'https://telemetry.nav.no/collect');

    render(<NaisMetaTags />);
    expect(metaContent('nais-app')).toBe('ssr-app');
    expect(metaContent('nais-team')).toBe('ssr-team');
    expect(metaContent('nais-telemetry-url')).toBe('https://telemetry.nav.no/collect');
  });

  it('renders nothing when nothing resolves', () => {
    render(<NaisMetaTags />);
    expect(document.querySelectorAll('meta')).toHaveLength(0);
  });

  it('applies overrides and the generatedConfig payload', () => {
    render(
      <NaisMetaTags
        overrides={{ app: 'override-app' }}
        naisConfig={{
          telemetryCollectorURL: 'https://cfg.example/collect',
          app: { name: 'cfg-app', namespace: 'cfg-team' },
        }}
      />
    );
    expect(metaContent('nais-app')).toBe('override-app');
    expect(metaContent('nais-team')).toBe('cfg-team');
    expect(metaContent('nais-telemetry-url')).toBe('https://cfg.example/collect');
  });
});
