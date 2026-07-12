/**
 * Property-based hardening of the PII scrubber (nais/grafana-apm-app#90).
 *
 * The example-based tests in scrub.test.ts cover the cases we thought of;
 * regex scrubbers fail on the embeddings we didn't. fast-check generates
 * PII-shaped identifiers embedded in arbitrary surrounding text and asserts
 * the scrubber's invariants hold. On failure, fast-check prints the seed and
 * the minimal counterexample — add that case to scrub.test.ts when fixing.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { looksLikePii, scrubString, scrubUrl } from './scrub.js';

const two = (n: number): string => String(n).padStart(2, '0');

/** 11-digit fødselsnummer with a plausible DDMMYY prefix (incl. D/H/synthetic variants). */
const fnrArb = fc
  .tuple(
    fc.oneof(fc.integer({ min: 1, max: 28 }), fc.integer({ min: 41, max: 68 })), // day (+40 = D-number)
    fc.oneof(
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 41, max: 52 }), // H-number
      fc.integer({ min: 81, max: 92 }) // synthetic
    ),
    fc.integer({ min: 0, max: 99 }), // year
    fc.integer({ min: 0, max: 99999 }) // individual digits + control
  )
  .map(([day, month, year, tail]) => `${two(day)}${two(month)}${two(year)}${String(tail).padStart(5, '0')}`);

/** Email matching the scrubber's charset, with realistic local/domain parts. */
const emailArb = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9._%+-]{1,20}$/),
    fc.stringMatching(/^[a-z0-9-]{1,15}$/),
    fc.constantFrom('no', 'com', 'io', 'dev', 'org')
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

/**
 * Surrounding text that preserves the scrubber's `\b` word boundaries. The
 * contract is: an fnr is detected when DELIMITED by non-word characters
 * (space, punctuation, start/end of string). A word character (letter, digit,
 * `_`) glued directly onto the number breaks the boundary by design — digits
 * because the 11 digits would just be part of a longer number (false-positive
 * guard), letters as a side effect of `\b` (see the documented-limitation
 * test at the bottom).
 */
const delimiterArb = fc.constantFrom(' ', '.', ',', ':', ';', '(', ')', '/', '\n', '\t', '"', "'", '!');
const textArb = fc.stringMatching(/^[a-zA-ZæøåÆØÅ0-9 .,]{0,20}$/);
const prefixArb = fc.oneof(
  fc.constant(''),
  fc.tuple(textArb, delimiterArb).map(([text, delimiter]) => text + delimiter)
);
const suffixArb = fc.oneof(
  fc.constant(''),
  fc.tuple(delimiterArb, textArb).map(([delimiter, text]) => delimiter + text)
);
/** Free-form surroundings for cases without boundary sensitivity (emails). */
const surroundingArb = fc.stringMatching(/^[a-zA-ZæøåÆØÅ .,;:()!?'"\n\t/-]{0,30}$/);

describe('scrubString properties', () => {
  it('redacts any plausible fnr that is properly delimited', () => {
    fc.assert(
      fc.property(fnrArb, prefixArb, suffixArb, (fnr, prefix, suffix) => {
        const scrubbed = scrubString(`${prefix}${fnr}${suffix}`);
        expect(scrubbed).toContain('[fnr]');
        expect(scrubbed).not.toContain(fnr);
      })
    );
  });

  it('redacts the space-separated fnr form too', () => {
    fc.assert(
      fc.property(fnrArb, prefixArb, suffixArb, (fnr, prefix, suffix) => {
        const spaced = `${fnr.slice(0, 6)} ${fnr.slice(6)}`;
        expect(scrubString(`${prefix}${spaced}${suffix}`)).toContain('[fnr]');
      })
    );
  });

  it('documents a known limitation: word-glued fnr is NOT detected (\\b boundary guard)', () => {
    // Found by the properties above on their first run (seed preserved in the
    // PR description): a letter glued directly onto the digits breaks the \b
    // boundary, so `bruker01017012345` passes through unscrubbed. Digits-glued
    // is deliberate (part of a longer number); letters-glued is a side effect
    // of \b treating [A-Za-z0-9_] uniformly. Tightening this means trading
    // against false positives on letter+digit identifiers — tracked as a
    // product decision, not silently changed here.
    expect(scrubString('bruker01017012345')).toBe('bruker01017012345');
    expect(scrubString('a41810000000')).toBe('a41810000000');
  });

  it('redacts any generated email wherever it is embedded', () => {
    fc.assert(
      fc.property(emailArb, surroundingArb, surroundingArb, (email, prefix, suffix) => {
        const scrubbed = scrubString(`${prefix}${email}${suffix}`);
        expect(scrubbed).toContain('[email]');
        expect(scrubbed).not.toContain(email);
      })
    );
  });

  it('redacts token-bearing query params while keeping the param name', () => {
    const paramArb = fc.constantFrom(
      'access_token',
      'id_token',
      'refresh_token',
      'token',
      'code',
      'state'
    );
    const valueArb = fc.stringMatching(/^[a-zA-Z0-9._~-]{1,40}$/);
    fc.assert(
      fc.property(paramArb, valueArb, fc.boolean(), (param, value, asFirst) => {
        const url = `https://app.nav.no/callback${asFirst ? '?' : '?x=1&'}${param}=${value}`;
        const scrubbed = scrubString(url);
        expect(scrubbed).toContain(`${param}=[redacted]`);
        expect(scrubbed).not.toContain(`${param}=${value}`);
      })
    );
  });

  it('is idempotent: scrubbing twice equals scrubbing once', () => {
    // Runs over fully arbitrary unicode strings AND over strings guaranteed
    // to contain PII — a second pass must never find (or manufacture) more.
    const withPii = fc
      .tuple(surroundingArb, fc.oneof(fnrArb, emailArb), surroundingArb)
      .map(([a, pii, b]) => `${a}${pii}${b}`);
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary' }), withPii), (s) => {
        const once = scrubString(s);
        expect(scrubString(once)).toBe(once);
      })
    );
  });

  it('never throws and always returns a string, whatever the input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        expect(typeof scrubString(s)).toBe('string');
      })
    );
  });
});

describe('looksLikePii properties', () => {
  it('flags every generated fnr, email, and raw NAV ident', () => {
    const identArb = fc
      .tuple(fc.constantFrom(...'ABCDEFGHZabz'), fc.integer({ min: 0, max: 999999 }))
      .map(([letter, digits]) => `${letter}${String(digits).padStart(6, '0')}`);
    fc.assert(
      fc.property(fc.oneof(fnrArb, emailArb, identArb), (pii) => {
        expect(looksLikePii(pii)).toBe(true);
      })
    );
  });

  it('passes opaque correlation keys (UUIDs) through', () => {
    fc.assert(
      fc.property(fc.uuid(), (id) => {
        expect(looksLikePii(id)).toBe(false);
      })
    );
  });
});

describe('scrubUrl properties', () => {
  it('always drops query string and fragment', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withQueryParameters: true, withFragments: true }),
        (url) => {
          const scrubbed = scrubUrl(url);
          expect(scrubbed).not.toContain('?');
          expect(scrubbed).not.toContain('#');
        }
      )
    );
  });

  it('masks fnr, UUID, and ident path segments wherever they sit in the path', () => {
    const segmentArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/);
    fc.assert(
      fc.property(fnrArb, fc.uuid(), segmentArb, segmentArb, (fnr, uuid, seg1, seg2) => {
        const scrubbed = scrubUrl(`https://app.nav.no/${seg1}/${fnr}/${uuid}/${seg2}`);
        expect(scrubbed).toBe(`https://app.nav.no/${seg1}/[fnr]/[uuid]/${seg2}`);
      })
    );
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        expect(typeof scrubUrl(s)).toBe('string');
      })
    );
  });
});
