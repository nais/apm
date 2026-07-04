import { describe, expect, it, beforeEach } from 'vitest';
import { gunzipSync } from 'fflate';
import type { eventWithTime } from '@grafana/rrweb-types';
import { buildChunks, encodeEvents, sendEvents, _resetChunkSeqForTesting } from './transport.js';
import { buildRecordMaskingOptions, buildSnapshotMaskingOptions } from './masking.js';
import { captureSnapshot, _resetSnapshotStateForTesting } from './snapshot.js';
import { REPLAY_CHUNK_EVENT_NAME } from './constants.js';

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
