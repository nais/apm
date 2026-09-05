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

it('no shipped source uses a regex lookbehind — parse-time SyntaxError on Safari < 16.4', () => {
  // This SDK is imported by every host app, and an unparseable module takes the
  // whole bundle down with it — so the ban covers everything we publish, not
  // just the scrubber. Vite's `?raw` loader reads the sources at transform time,
  // so this needs neither `@types/node` nor a runtime file read.
  // @ts-expect-error -- `import.meta.glob` is a Vite built-in; no ambient declaration in this repo.
  const sources = import.meta.glob('./**/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const shipped = Object.entries(sources).filter(([path]) => !path.includes('.test.'));
  expect(shipped.length).toBeGreaterThan(10); // the glob actually resolved something
  for (const [path, source] of shipped) {
    expect(source, `${path} must stay lookbehind-free`).not.toMatch(/\(\?<[!=]/);
  }
});

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

/** 11-digit fnr whose two mod11 control digits actually check out. */
const K1_WEIGHTS = [3, 7, 6, 1, 8, 9, 4, 5, 2];
const K2_WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
const control = (digits: string, weights: number[]): number => {
  const rest = 11 - (weights.reduce((acc, w, i) => acc + w * Number(digits[i]), 0) % 11);
  return rest === 11 ? 0 : rest;
};
/** Append the two control digits to a 9-digit stem; `null` when they are unrepresentable. */
const withControlDigits = (stem: string): string | null => {
  const k1 = control(stem, K1_WEIGHTS);
  if (k1 === 10) return null;
  const k2 = control(stem + k1, K2_WEIGHTS);
  return k2 === 10 ? null : `${stem}${k1}${k2}`;
};
const validFnrArb = fnrArb
  .map((fnr) => withControlDigits(fnr.slice(0, 9)))
  .filter((fnr): fnr is string => fnr !== null);

/**
 * Surrounding text that preserves the scrubber's digit boundaries. The
 * contract is: an fnr is detected when DELIMITED by non-digits (space,
 * punctuation, start/end of string). A digit glued directly onto the number
 * breaks the boundary by design — the 11 digits would just be part of a longer
 * number (false-positive guard). Letters and `_` no longer break it, but a
 * letter-glued run must pass mod11 to be masked (nais/apm#20).
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

  it('redacts a letter-glued fnr when the mod11 control digits check out', () => {
    fc.assert(
      fc.property(validFnrArb, fc.stringMatching(/^[a-zæøå]{1,10}$/), (fnr, word) => {
        expect(scrubString(`${word}${fnr}`)).toBe(`${word}[fnr]`);
        expect(scrubString(`${fnr}${word}`)).toBe(`[fnr]${word}`);
      })
    );
  });

  it('leaves a letter-glued 11-digit run alone when mod11 fails', () => {
    // The gap that nais/apm#20 closed, and the guard that came with it. `\b`
    // used to let ANY letter-glued run through; digit-only lookarounds catch
    // them, and mod11 keeps case numbers / external identifiers that merely
    // contain a plausible 11-digit run out of the false-positive bucket.
    expect(scrubString('bruker01017000027')).toBe('bruker[fnr]'); // valid → masked
    expect(scrubString('bruker01017012345')).toBe('bruker01017012345'); // bad control digits
    expect(scrubString('a41810000000')).toBe('a41810000000'); // #20's counterexample
    expect(scrubString('sak_01017012345')).toBe('sak_01017012345');
  });

  it('still leaves an fnr-shaped run inside a longer number alone', () => {
    fc.assert(
      fc.property(validFnrArb, fc.integer({ min: 1, max: 9 }), (fnr, digit) => {
        expect(scrubString(`${digit}${fnr}`)).not.toContain('[fnr]');
        expect(scrubString(`${fnr}${digit}`)).not.toContain('[fnr]');
      })
    );
  });

  it('leaves hex identifiers alone when a valid fnr slice sits inside them', () => {
    // Each of these is a real generated traceId/spanId carrying an 11-digit run
    // that clears BOTH mod11 control digits and a plausible date — every one was
    // rewritten before the hex-flank guard (e.g. the first became
    // `007acc536a[fnr]c22305e9b6a`), which breaks trace correlation in this
    // SDK's own payloads and makes looksLikePii blank the value to [ident].
    // Canonical dashed UUIDs cannot hit this: no segment is long enough to hold
    // a hex letter + 11 digits + a hex letter. Undashed 32-hex ids are traceIds.
    const hexIds = [
      '007acc536a01087335832c22305e9b6a',
      'e17042517844b644d28fe09afa20618f',
      '46f33e2f21128833894d2acf90729b58',
      'f71896339626c26f3931c4db4eafef0e',
      'f02100674184ceab',
      'c5a11060825868cf',
    ];
    for (const id of hexIds) {
      expect(scrubString(id)).toBe(id);
      expect(looksLikePii(id)).toBe(false);
    }
  });

  it('still masks an fnr glued to a hex letter on one side only', () => {
    // The guard needs hex letters on BOTH sides, so #20's fix is untouched:
    // `bruker`/`sak`-style prefixes glue on one side and still qualify.
    expect(scrubString('a01017000027 ')).toBe('a[fnr] ');
    expect(scrubString(' 01017000027f')).toBe(' [fnr]f');
    expect(scrubString('bruker01017000027')).toBe('bruker[fnr]');
  });

  it('does not let a rejected candidate swallow the fnr that overlaps it', () => {
    // The scanner's reason for existing: the greedy optional space matches
    // `123456 01017` first, which is rejected (a digit follows). Skipping past
    // it would eat the real fnr starting at offset 7.
    expect(scrubString('123456 01017000027')).toBe('123456 [fnr]');
    fc.assert(
      fc.property(fnrArb, fc.stringMatching(/^[0-9]{6}$/), (fnr, noise) => {
        expect(scrubString(`${noise} ${fnr}`)).toBe(`${noise} [fnr]`);
      })
    );
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
