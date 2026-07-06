import { describe, expect, it, vi } from 'vitest';
import { TransportItemType } from '@grafana/faro-web-sdk';
import type {
  EventEvent,
  ExceptionEvent,
  LogEvent,
  MeasurementEvent,
  Meta,
  TransportItem,
} from '@grafana/faro-web-sdk';

import {
  composeBeforeSend,
  looksLikePii,
  scrubReplayEvents,
  scrubString,
  scrubTransportItem,
  scrubUrl,
} from './scrub.js';

describe('scrubString — fødselsnummer', () => {
  it('masks an fnr without a space', () => {
    expect(scrubString('user 01017012345 failed')).toBe('user [fnr] failed');
  });

  it('masks an fnr with a space between date and individual digits', () => {
    expect(scrubString('fnr: 010170 12345')).toBe('fnr: [fnr]');
  });

  it('masks D-numbers (day + 40)', () => {
    expect(scrubString('41017012345')).toBe('[fnr]');
  });

  it('masks synthetic test numbers (month + 80)', () => {
    expect(scrubString('01817012345')).toBe('[fnr]');
  });

  it('leaves 11-digit numbers with an implausible date prefix alone', () => {
    expect(scrubString('order 99999912345 shipped')).toBe('order 99999912345 shipped');
    expect(scrubString('32137012345')).toBe('32137012345');
  });

  it('leaves shorter and longer digit runs alone', () => {
    expect(scrubString('0101701234')).toBe('0101701234');
    expect(scrubString('010170123456')).toBe('010170123456');
  });
});

describe('scrubString — emails', () => {
  it('masks emails', () => {
    expect(scrubString('Contact ola.nordmann@nav.no now')).toBe('Contact [email] now');
    expect(scrubString('a+b@sub.example.co.uk!')).toBe('[email]!');
  });
});

describe('scrubString — token-bearing URLs', () => {
  it('redacts token-ish query params, keeping other params', () => {
    expect(scrubString('https://app.nav.no/cb?code=abc123&foo=bar&state=xyz')).toBe(
      'https://app.nav.no/cb?code=[redacted]&foo=bar&state=[redacted]'
    );
  });

  it('redacts access_token/id_token/token', () => {
    expect(scrubString('url?access_token=eyJhbGc&id_token=eyJ0eXA&token=t0k3n')).toBe(
      'url?access_token=[redacted]&id_token=[redacted]&token=[redacted]'
    );
  });

  it('redacts tokens in URL fragments', () => {
    expect(scrubString('https://a/cb#access_token=eyJhbGc')).toBe('https://a/cb#access_token=[redacted]');
  });

  it('redacts tokens inside stack trace strings', () => {
    const stack = 'Error: boom\n    at fetchUser (https://app.nav.no/assets/x.js?token=secret123:1:2)';
    expect(scrubString(stack)).toContain('?token=[redacted]:1:2');
  });
});

describe('scrubUrl', () => {
  it('strips the query string and fragment entirely', () => {
    expect(scrubUrl('https://app.nav.no/sak/vedtak?token=eyJhbGc&foo=bar')).toBe(
      'https://app.nav.no/sak/vedtak'
    );
    expect(scrubUrl('https://app.nav.no/behandling#access_token=eyJ')).toBe(
      'https://app.nav.no/behandling'
    );
  });

  it('masks a fødselsnummer path segment', () => {
    expect(scrubUrl('https://app.nav.no/sak/01017012345/vedtak')).toBe(
      'https://app.nav.no/sak/[fnr]/vedtak'
    );
    // Also with the query string carrying a token.
    expect(scrubUrl('/person/010170 12345?fnr=x')).toBe('/person/[fnr]');
  });

  it('masks a UUID path segment', () => {
    expect(scrubUrl('https://app.nav.no/aktor/1b4e28ba-2fa1-11d2-883f-0016d3cca427/detaljer')).toBe(
      'https://app.nav.no/aktor/[uuid]/detaljer'
    );
  });

  it('masks a NAV ident and an email path segment', () => {
    expect(scrubUrl('/saksbehandler/Z994488')).toBe('/saksbehandler/[ident]');
    expect(scrubUrl('/bruker/ola.nordmann@nav.no/profil')).toBe('/bruker/[email]/profil');
  });

  it('leaves a clean URL untouched', () => {
    expect(scrubUrl('https://app.nav.no/dashboard/oversikt')).toBe(
      'https://app.nav.no/dashboard/oversikt'
    );
  });

  it('leaves a name-slug path (not pattern-shaped) — documented residual', () => {
    expect(scrubUrl('https://app.nav.no/sak/ola-nordmann/')).toBe(
      'https://app.nav.no/sak/ola-nordmann/'
    );
  });
});

describe('scrubReplayEvents', () => {
  it('scrubs fnr/email/token in attribute strings and URLs deep in the node tree', () => {
    const events = [
      {
        type: 2,
        data: {
          node: {
            tagName: 'a',
            attributes: {
              href: '/sak/01017012345/vedtak?token=eyJhbGc',
              title: 'Slett bruker ola.nordmann@nav.no',
            },
            childNodes: [{ type: 3, textContent: 'kontakt 010170 12345' }],
          },
        },
        timestamp: 1,
      },
    ];
    const scrubbed = scrubReplayEvents(events) as typeof events;
    const attrs = scrubbed[0]!.data.node.attributes;
    expect(attrs.href).toBe('/sak/[fnr]/vedtak?token=[redacted]');
    expect(attrs.title).toBe('Slett bruker [email]');
    expect((scrubbed[0]!.data.node.childNodes[0] as { textContent: string }).textContent).toBe(
      'kontakt [fnr]'
    );
  });
});

function exceptionItem(overrides: Partial<ExceptionEvent> = {}, pageUrl?: string): TransportItem<ExceptionEvent> {
  return {
    type: TransportItemType.EXCEPTION,
    payload: {
      timestamp: '2026-07-03T00:00:00Z',
      type: 'Error',
      value: 'boom',
      ...overrides,
    },
    meta: (pageUrl ? { page: { url: pageUrl } } : {}) as Meta,
  };
}

describe('scrubTransportItem', () => {
  it('scrubs the exception value', () => {
    const item = exceptionItem({ value: 'lookup failed for 01017012345 (ola@nav.no)' });
    const scrubbed = scrubTransportItem(item) as TransportItem<ExceptionEvent>;
    expect(scrubbed.payload.value).toBe('lookup failed for [fnr] ([email])');
  });

  it('scrubs stack trace frames', () => {
    const item = exceptionItem({
      stacktrace: {
        frames: [{ filename: 'https://app.nav.no/x.js?token=hemmelig', function: 'save 01017012345' }],
      },
    });
    const scrubbed = scrubTransportItem(item) as TransportItem<ExceptionEvent>;
    expect(scrubbed.payload.stacktrace?.frames[0]?.filename).toBe('https://app.nav.no/x.js?token=[redacted]');
    expect(scrubbed.payload.stacktrace?.frames[0]?.function).toBe('save [fnr]');
  });

  it('scrubs context values', () => {
    const item = exceptionItem({ context: { user: 'ola@nav.no' } });
    const scrubbed = scrubTransportItem(item) as TransportItem<ExceptionEvent>;
    expect(scrubbed.payload.context?.['user']).toBe('[email]');
  });

  it('scrubs page_url in meta', () => {
    const item = exceptionItem({}, 'https://app.nav.no/callback?code=abc&state=s3cret');
    const scrubbed = scrubTransportItem(item);
    expect(scrubbed.meta.page?.url).toBe('https://app.nav.no/callback?code=[redacted]&state=[redacted]');
  });

  it('scrubs log lines', () => {
    const item: TransportItem<LogEvent> = {
      type: TransportItemType.LOG,
      payload: {
        message: 'sent to ola@nav.no',
        level: 'info',
        timestamp: '2026-07-03T00:00:00Z',
        context: undefined,
      } as LogEvent,
      meta: {} as Meta,
    };
    const scrubbed = scrubTransportItem(item) as TransportItem<LogEvent>;
    expect(scrubbed.payload.message).toBe('sent to [email]');
  });

  it('does not mutate the original item', () => {
    const item = exceptionItem({ value: 'ola@nav.no' });
    scrubTransportItem(item);
    expect(item.payload.value).toBe('ola@nav.no');
  });
});

function measurementItem(payload: Partial<MeasurementEvent>): TransportItem<MeasurementEvent> {
  return {
    type: TransportItemType.MEASUREMENT,
    payload: {
      type: 'custom',
      values: {},
      timestamp: '2026-07-03T00:00:00Z',
      ...payload,
    },
    meta: {} as Meta,
  };
}

function eventItem(payload: Partial<EventEvent>): TransportItem<EventEvent> {
  return {
    type: TransportItemType.EVENT,
    payload: {
      name: 'custom.event',
      timestamp: '2026-07-03T00:00:00Z',
      ...payload,
    },
    meta: {} as Meta,
  };
}

describe('scrubTransportItem — NAV ident redaction (measurements & events)', () => {
  it('redacts a bare NAV ident in measurement context', () => {
    const item = measurementItem({
      values: { duration_ms: 123 },
      context: { user_id: 'Z994455', page: 'oversikt' },
    });
    const scrubbed = scrubTransportItem(item) as TransportItem<MeasurementEvent>;
    expect(scrubbed.payload.context?.['user_id']).toBe('[ident]');
    // A legitimate low-cardinality label is left alone.
    expect(scrubbed.payload.context?.['page']).toBe('oversikt');
  });

  it('never touches numeric measurement values (they are the metric)', () => {
    const item = measurementItem({
      values: { duration_ms: 994455, count: 42 },
      context: { user_id: 'Z994455' },
    });
    const scrubbed = scrubTransportItem(item) as TransportItem<MeasurementEvent>;
    expect(scrubbed.payload.values).toEqual({ duration_ms: 994455, count: 42 });
    expect(scrubbed.payload.context?.['user_id']).toBe('[ident]');
  });

  it('still applies the fnr/email/token patterns to measurement context', () => {
    const item = measurementItem({
      context: { owner: 'ola@nav.no', ref: 'fnr 01017012345' },
    });
    const scrubbed = scrubTransportItem(item) as TransportItem<MeasurementEvent>;
    expect(scrubbed.payload.context?.['owner']).toBe('[email]');
    expect(scrubbed.payload.context?.['ref']).toBe('fnr [fnr]');
  });

  it('redacts a bare NAV ident in event attributes', () => {
    const item = eventItem({
      attributes: { user_id: 'Z994455', enhet: 'Nav Grünerløkka', action: 'save' },
    });
    const scrubbed = scrubTransportItem(item) as TransportItem<EventEvent>;
    expect(scrubbed.payload.attributes?.['user_id']).toBe('[ident]');
    // A name label is not pattern-shaped — documented residual, left as-is.
    expect(scrubbed.payload.attributes?.['enhet']).toBe('Nav Grünerløkka');
    expect(scrubbed.payload.attributes?.['action']).toBe('save');
  });

  it('does not mutate the original measurement item', () => {
    const item = measurementItem({ context: { user_id: 'Z994455' } });
    scrubTransportItem(item);
    expect(item.payload.context?.['user_id']).toBe('Z994455');
  });
});

describe('composeBeforeSend', () => {
  it('runs the user hook first, scrubber last', () => {
    const userHook = vi.fn((item: TransportItem) => ({
      ...item,
      payload: { ...(item.payload as ExceptionEvent), value: 'user-hook saw ola@nav.no' },
    }));
    const hook = composeBeforeSend(userHook as never, false)!;
    const result = hook(exceptionItem({ value: 'original' })) as TransportItem<ExceptionEvent>;
    expect(userHook).toHaveBeenCalledOnce();
    // Value set by the user hook is still scrubbed → scrubber ran after.
    expect(result.payload.value).toBe('user-hook saw [email]');
  });

  it('lets the user hook drop items', () => {
    const hook = composeBeforeSend(() => null, false)!;
    expect(hook(exceptionItem())).toBeNull();
  });

  it('scrubs without a user hook', () => {
    const hook = composeBeforeSend(undefined, false)!;
    const result = hook(exceptionItem({ value: 'fnr 010170 12345' })) as TransportItem<ExceptionEvent>;
    expect(result.payload.value).toBe('fnr [fnr]');
  });

  it('opt-out via dangerouslyDisablePiiScrubbing returns the raw user hook', () => {
    const userHook = vi.fn((item: TransportItem) => item);
    expect(composeBeforeSend(userHook as never, true)).toBe(userHook);
    const noHook = composeBeforeSend(undefined, true);
    expect(noHook).toBeUndefined();
  });
});

describe('looksLikePii', () => {
  it('flags a fødselsnummer', () => {
    expect(looksLikePii('01017012345')).toBe(true);
    expect(looksLikePii('010170 12345')).toBe(true);
  });

  it('flags an email', () => {
    expect(looksLikePii('ola.nordmann@nav.no')).toBe(true);
  });

  it('flags a raw NAV ident (letter + six digits)', () => {
    expect(looksLikePii('Z994488')).toBe(true);
  });

  it('passes opaque correlation keys through', () => {
    expect(looksLikePii('a1b2c3')).toBe(false);
    expect(looksLikePii('sha256:deadbeefcafef00d')).toBe(false);
    expect(looksLikePii('01017012345-plus-suffix')).toBe(true); // still contains an fnr
  });
});
