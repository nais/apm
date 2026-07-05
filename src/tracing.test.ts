import { describe, expect, it, vi } from 'vitest';
import type { Faro } from '@grafana/faro-web-sdk';

import { buildPropagationBase, resolvePropagateUrls, startTracing } from './tracing.js';

const NAV_NO_SOURCE = /^https:\/\/[^/]*\.nav\.no/.source;

function navRegexOf(urls: (string | RegExp)[]): RegExp {
  const re = urls.find((u) => u instanceof RegExp && u.source === NAV_NO_SOURCE);
  if (!(re instanceof RegExp)) {
    throw new Error('nav.no propagation regex missing from the base');
  }
  return re;
}

describe('tracing header-propagation floor', () => {
  it('always includes same-origin and *.nav.no', () => {
    const urls = resolvePropagateUrls(undefined);
    // jsdom serves from http://localhost:3000
    expect(urls).toContain(window.location.origin);
    const nav = navRegexOf(urls);
    expect(nav.test('https://api.nav.no')).toBe(true);
    expect(nav.test('https://sub.dev.nav.no')).toBe(true);
  });

  it('rejects third-party origins (not in the floor, nav regex does not match them)', () => {
    const urls = resolvePropagateUrls(undefined);
    expect(urls).not.toContain('https://evil.example.com');
    const nav = navRegexOf(urls);
    expect(nav.test('https://evil.example.com')).toBe(false);
    expect(nav.test('https://nav.no.evil.com')).toBe(false);
  });

  it('appends extra origins without emptying the mandatory base', () => {
    const extra: (string | RegExp)[] = ['https://extra.example.com', /^https:\/\/foo\.bar/];
    const urls = resolvePropagateUrls(extra);
    // Base is still present...
    expect(urls).toContain(window.location.origin);
    expect(navRegexOf(urls)).toBeInstanceOf(RegExp);
    // ...and the extras were appended after it.
    expect(urls).toContain('https://extra.example.com');
    expect(urls.length).toBe(buildPropagationBase().length + extra.length);
    expect(urls.slice(0, buildPropagationBase().length)).toEqual(buildPropagationBase());
  });
});

describe('startTracing', () => {
  it('late-adds an instrumentation built with the resolved propagate list', () => {
    const add = vi.fn();
    const faro = { instrumentations: { add } } as unknown as Faro;
    const fake = { name: 'fake-tracing' };
    let seenUrls: (string | RegExp)[] | undefined;

    startTracing(faro, {
      propagateExtraOrigins: ['https://extra.nav.no'],
      instrumentationFactory: (urls) => {
        seenUrls = urls;
        return fake;
      },
    });

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(fake);
    expect(seenUrls).toContain(window.location.origin);
    expect(seenUrls).toContain('https://extra.nav.no');
    expect(navRegexOf(seenUrls!)).toBeInstanceOf(RegExp);
  });

  it('never throws when the instrumentation fails to add', () => {
    const faro = {
      instrumentations: {
        add: () => {
          throw new Error('boom');
        },
      },
    } as unknown as Faro;
    expect(() => startTracing(faro, { instrumentationFactory: () => ({}) })).not.toThrow();
  });
});
