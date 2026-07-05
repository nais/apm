import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { gunzipSync } from 'fflate';
import type { eventWithTime } from '@grafana/rrweb-types';
import { buildChunks, encodeEvents, sendEvents, _resetChunkSeqForTesting } from './transport.js';
import { buildRecordMaskingOptions, buildSnapshotMaskingOptions } from './masking.js';
import { captureSnapshot, _resetSnapshotStateForTesting } from './snapshot.js';
import { REPLAY_CHUNK_EVENT_NAME } from './constants.js';
import {
  normalizeSessionReplay,
  _resetSessionReplayWarningForTesting,
} from './options.js';
import {
  startEventsCollection,
  EVENTS_CLICK,
  EVENTS_RAGE_CLICK,
  EVENTS_NAVIGATION,
  EVENTS_ERROR,
} from './events.js';

function pseudoRandom(seed: number, length: number): string {
  // Deterministic, incompressible-enough payload (gzip flattens repetition).
  let out = '';
  let s = seed;
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out += String.fromCharCode(33 + (s % 90));
  }
  return out;
}

function ev(timestamp: number, size = 10): eventWithTime {
  return { type: 3, data: { text: pseudoRandom(timestamp + 1, size) }, timestamp } as unknown as eventWithTime;
}

function decode(data: string): eventWithTime[] {
  const bin = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(gunzipSync(bin)));
}

describe('transport wire contract', () => {
  beforeEach(() => _resetChunkSeqForTesting());

  it('round-trips events through gzip+b64', () => {
    const events = [ev(1000), ev(2000), ev(3000)];
    const { chunks, dropped } = buildChunks(events);
    expect(dropped).toBe(0);
    expect(chunks).toHaveLength(1);
    expect(decode(chunks[0]!.data)).toEqual(events);
  });

  it('splits into multiple chunks under the cap, preserving order', () => {
    // Random-ish payloads so gzip cannot flatten them into one tiny chunk.
    const events = Array.from({ length: 40 }, (_, i) => ev(i, 500));
    const { chunks, dropped } = buildChunks(events, 2_000);
    expect(dropped).toBe(0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.data.length).toBeLessThanOrEqual(2_000);
    }
    const roundTripped = chunks.flatMap((c) => decode(c.data));
    expect(roundTripped.map((e) => e.timestamp)).toEqual(events.map((e) => e.timestamp));
  });

  it('drops single oversized events and accounts for them', () => {
    const big = ev(1, 500_000);
    const { chunks, dropped } = buildChunks([ev(0), big, ev(2)], 2_000);
    expect(dropped).toBe(1);
    expect(chunks.flatMap((c) => decode(c.data)).map((e) => e.timestamp)).toEqual([0, 2]);
  });

  it('sendEvents pushes contract-shaped attributes with monotonic chunk_seq', () => {
    const pushed: Array<{ name: string; attrs: Record<string, string> }> = [];
    sendEvents([ev(1000), ev(2000)], 'snapshot', (name, attrs) => pushed.push({ name, attrs }));
    sendEvents([ev(3000)], 'recording', (name, attrs) => pushed.push({ name, attrs }));

    expect(pushed[0]!.name).toBe(REPLAY_CHUNK_EVENT_NAME);
    const first = pushed[0]!.attrs;
    expect(first.mode).toBe('snapshot');
    expect(first.enc).toBe('gzip+b64');
    expect(first.chunk_seq).toBe('0');
    expect(first.count).toBe('2');
    expect(first.first_ts).toBe('1000');
    expect(first.last_ts).toBe('2000');
    expect(decode(first.data!)).toHaveLength(2);
    expect(pushed[1]!.attrs.chunk_seq).toBe('1');
  });
});

describe('transport PII scrub pass (before gzip)', () => {
  it('scrubs fnr/email/token in attributes and URLs, and still round-trips', () => {
    const events = [
      {
        type: 4,
        data: { href: 'https://app.nav.no/behandling/01017012345?token=eyJhbGc' },
        timestamp: 1,
      },
      {
        type: 2,
        data: {
          node: {
            tagName: 'a',
            attributes: { href: '/sak/010170 12345/vedtak', title: 'send til ola@nav.no' },
          },
        },
        timestamp: 2,
      },
    ] as unknown as eventWithTime[];

    const decoded = decode(encodeEvents(events)) as unknown as Array<{ data: Record<string, unknown> }>;
    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.data.href).toBe('https://app.nav.no/behandling/[fnr]?token=[redacted]');
    const attrs = (decoded[1]!.data.node as { attributes: Record<string, string> }).attributes;
    expect(attrs.href).toBe('/sak/[fnr]/vedtak');
    expect(attrs.title).toBe('send til [email]');
  });
});

describe('masking floor', () => {
  it('always masks inputs and text and blocks media', () => {
    const rec = buildRecordMaskingOptions();
    expect(rec.maskAllInputs).toBe(true);
    expect(rec.maskTextSelector).toBe('*');
    expect(rec.inlineImages).toBe(false);
    expect(rec.inlineStylesheet).toBe(false);

    const snap = buildSnapshotMaskingOptions(['.custom-secret']);
    expect(snap.maskAllInputs).toBe(true);
    expect(snap.blockSelector).toContain('.custom-secret');
    expect(snap.blockSelector).toContain('[data-apm-block]');
  });
});

describe('snapshot throttling', () => {
  beforeEach(() => _resetSnapshotStateForTesting());

  const fakeSnapshot = () => ({ id: 1, type: 0, childNodes: [] }) as unknown as ReturnType<typeof Object>;

  it('captures once per error message and caps per session', async () => {
    const pushed: string[] = [];
    const push = (name: string) => pushed.push(name);

    expect(await captureSnapshot('boom A', push, { snapshotFn: fakeSnapshot as never })).toBe(true);
    expect(await captureSnapshot('boom A', push, { snapshotFn: fakeSnapshot as never })).toBe(false); // same message
    expect(await captureSnapshot('boom B', push, { snapshotFn: fakeSnapshot as never })).toBe(true);
    expect(await captureSnapshot('boom C', push, { snapshotFn: fakeSnapshot as never })).toBe(true);
    expect(await captureSnapshot('boom D', push, { snapshotFn: fakeSnapshot as never })).toBe(false); // session cap 3
    expect(pushed.length).toBeGreaterThanOrEqual(3);
  });

  it('scrubs the Meta href (query string + fnr path segment) before it ships', async () => {
    window.history.replaceState(null, '', '/behandling/01017012345/steg?token=eyJhbGc');

    const pushed: Array<Record<string, string>> = [];
    const push = (_name: string, attrs: Record<string, string>) => pushed.push(attrs);
    expect(await captureSnapshot('boom href', push, { snapshotFn: fakeSnapshot as never })).toBe(true);

    const meta = pushed
      .flatMap((attrs) => decode(attrs.data!))
      .find((e) => (e as unknown as { type: number }).type === 4) as unknown as {
      data: { href: string };
    };
    expect(meta.data.href).toBe('http://localhost:3000/behandling/[fnr]/steg');
  });
});

describe('session replay option normalization (Decision 0)', () => {
  beforeEach(() => _resetSessionReplayWarningForTesting());

  it('defaults enabled replay with no tier to the events tier', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const normalized = normalizeSessionReplay({ enabled: true });
    expect(normalized.enabled).toBe(true);
    expect(normalized.tier).toBe('events');
    // `mode` is the capture trigger and is unchanged/independent of the tier.
    expect(normalized.mode).toBe('on-error');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('defaults to the events tier'));
    warn.mockRestore();
  });

  it("keeps tier:'dom' (the DOM recording path) when explicitly requested", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const normalized = normalizeSessionReplay({ enabled: true, tier: 'dom', mode: 'always' });
    expect(normalized.tier).toBe('dom');
    expect(normalized.mode).toBe('always');
    // No deprecation warning when the tier is explicit.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns exactly once about the default-tier change (idempotent)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    normalizeSessionReplay({ enabled: true });
    normalizeSessionReplay({ enabled: true });
    normalizeSessionReplay({ enabled: true, mode: 'always' });
    const deprecationCalls = warn.mock.calls.filter((c) =>
      String(c[0]).includes('defaults to the events tier')
    );
    expect(deprecationCalls).toHaveLength(1);
    warn.mockRestore();
  });

  it('does not warn when replay is disabled (nothing changed for that config)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const normalized = normalizeSessionReplay({ enabled: false });
    expect(normalized.enabled).toBe(false);
    expect(normalized.tier).toBe('events');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects an unknown tier by falling back to events with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const normalized = normalizeSessionReplay({ enabled: true, tier: 'screenshot' as never });
    expect(normalized.tier).toBe('events');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown session replay tier'));
    warn.mockRestore();
  });
});

describe('events tier — interaction timeline with NO DOM leak (the key guarantee)', () => {
  // PII deliberately planted across text, input value, title and a data-* JSON
  // blob — exactly the shapes a DOM/FullSnapshot capture would carry.
  // The actual sensitive VALUES (not the `[fnr]` redaction placeholder, whose
  // presence is the scrubber working as intended).
  const PII_STRINGS = ['01017012345', 'Ola', 'ola@nav.no', 'secret-value'];

  function seedDomWithPii(): HTMLButtonElement {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    container.setAttribute('data-initial-state', '{"fnr":"01017012345","name":"Ola"}');

    const input = document.createElement('input');
    input.value = 'secret-value';
    input.setAttribute('title', 'Ola 01017012345');

    const button = document.createElement('button');
    button.setAttribute('role', 'button');
    button.textContent = 'send til ola@nav.no';

    container.append(input, button);
    document.body.appendChild(container);
    return button;
  }

  afterEach(() => {
    document.body.innerHTML = '';
    window.history.replaceState(null, '', '/');
  });

  it('captures only tag/role/coords/timestamps + a scrubbed URL — no FullSnapshot, no node tree, no PII', () => {
    window.history.replaceState(null, '', '/behandling/01017012345/steg?token=eyJhbGc');
    const button = seedDomWithPii();

    const pushed: Array<{ name: string; attrs: Record<string, string> }> = [];
    const handle = startEventsCollection({
      mode: 'always',
      push: (name, attrs) => pushed.push({ name, attrs }),
    })!;
    expect(handle).toBeDefined();

    // Drive real interactions over the PII-laden DOM.
    for (let i = 0; i < 3; i++) {
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: 40, clientY: 40 })
      );
    }
    window.history.pushState(null, '', '/behandling/24118012345/kvittering');
    handle.stop();

    // Everything the collector pushed, flattened to a single string blob.
    const blob = JSON.stringify(pushed);

    // (1) Structurally no rrweb capture: no FullSnapshot (type 2), no node tree.
    for (const { attrs } of pushed) {
      expect(attrs).not.toHaveProperty('data'); // no gzip chunk payload
      expect(JSON.stringify(attrs)).not.toMatch(/"type"\s*:\s*2/);
    }
    expect(blob).not.toContain('childNodes');
    expect(blob).not.toContain('FullSnapshot');
    expect(blob).not.toContain('tagName'); // rrweb node key
    expect(blob).not.toContain('data-initial-state');

    // (2) None of the planted PII escaped, from any source (text/value/title/data-*).
    for (const pii of PII_STRINGS) {
      expect(blob).not.toContain(pii);
    }

    // (3) The timeline IS present and carries only safe descriptors.
    const clicks = pushed.filter((p) => p.name === EVENTS_CLICK);
    expect(clicks.length).toBe(3);
    expect(clicks[0]!.attrs).toMatchObject({ tag: 'button', role: 'button' });
    expect(clicks[0]!.attrs.x).toBe('40');
    expect(Number.isNaN(Number(clicks[0]!.attrs.t))).toBe(false);
    expect(pushed.some((p) => p.name === EVENTS_RAGE_CLICK)).toBe(true);

    // (4) URLs are scrubUrl-clean (fnr path segment + query string gone).
    const navs = pushed.filter((p) => p.name === EVENTS_NAVIGATION);
    expect(navs.length).toBeGreaterThanOrEqual(2);
    for (const nav of navs) {
      expect(nav.attrs.url).not.toContain('01017012345');
      expect(nav.attrs.url).not.toContain('24118012345');
      expect(nav.attrs.url).not.toContain('token=');
      expect(nav.attrs.url).toContain('[fnr]');
    }
  });

  it('buffers the timeline in on-error mode and flushes + marks on the first error', () => {
    const pushed: Array<{ name: string; attrs: Record<string, string> }> = [];
    const handle = startEventsCollection({
      mode: 'on-error',
      push: (name, attrs) => pushed.push({ name, attrs }),
    })!;

    // Nothing ships before the error — the entry navigation is buffered.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1, clientY: 1 }));
    expect(pushed).toHaveLength(0);
    expect(handle.isStreaming).toBe(false);

    handle.notifyError();

    // The buffered timeline is flushed and an error marker is appended.
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed.some((p) => p.name === EVENTS_NAVIGATION)).toBe(true);
    expect(pushed.some((p) => p.name === EVENTS_CLICK)).toBe(true);
    expect(pushed[pushed.length - 1]!.name).toBe(EVENTS_ERROR);
    expect(handle.isStreaming).toBe(true);

    // After the first error the collector streams live.
    const before = pushed.length;
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 2, clientY: 2 }));
    expect(pushed.length).toBeGreaterThan(before);
    handle.stop();
  });
});
