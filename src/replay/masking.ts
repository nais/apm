/**
 * The NON-OVERRIDABLE privacy floor for all replay capture
 * (nais/grafana-apm-app#58, #67, #82).
 *
 * Everything is masked at serialization time, in the browser, before any byte
 * leaves the user's machine:
 *   - every input value is masked (`maskAllInputs`, no exceptions — inputs can
 *     never be unmasked, not even with `data-apm-unmask`),
 *   - all text is masked (`maskTextSelector: '*'`) except elements inside an
 *     explicit `data-apm-unmask` allowlist attribute,
 *   - masked text and input values collapse to a FIXED token, not a
 *     per-character map — masking is deliberately NOT length- or word-shape
 *     preserving (an 11-`*` run reads as a fødselsnummer; see #82 Part 2.4),
 *   - media, canvas, iframes, embeds, file inputs and `[data-apm-block]` are
 *     always blocked,
 *   - images and stylesheets are never inlined.
 *
 * There is deliberately no options path to weaken any of this: the builders
 * only accept extra `block` selectors (privacy can only be tightened) and the
 * returned option fragments are deep-frozen — mutation throws in strict mode.
 *
 * Attribute values are NOT masked here — the pinned fork
 * `@grafana/rrweb@2.0.0-grafana.2` exposes `maskInputFn` but NOT
 * `maskAttributeFn`. The attribute backstop is the payload scrub in
 * `transport.ts` (`scrubReplayEvents`), which runs over the serialized events
 * before gzip. Do not rely on this module for attribute PII.
 */

export const UNMASK_ATTRIBUTE = 'data-apm-unmask';
export const BLOCK_ATTRIBUTE = 'data-apm-block';

const UNMASK_SELECTOR = `[${UNMASK_ATTRIBUTE}]`;

/**
 * The single token every masked text node and input value collapses to.
 *
 * A fixed constant (not a per-character `*` map) so masking leaks neither the
 * length nor the word/line shape of the original — an 11-char run and a 5-char
 * run mask to the exact same string. The trade-off is a slight replay layout
 * shift (masked runs no longer match the original width); acceptable for a
 * privacy tier.
 */
export const MASKED_TOKEN = '•••';

/** Always-blocked elements. Apps can add selectors; these can never be removed. */
const BASE_BLOCK_SELECTORS: readonly string[] = [
  'img',
  'picture',
  'svg image',
  'video',
  'audio',
  'canvas',
  'iframe',
  'embed',
  'object',
  // A chosen filename is PII and is NOT an input *value* rrweb masks, so block
  // the whole control rather than trying to mask it (#82 Part 2.4/2c).
  'input[type=file]',
  `[${BLOCK_ATTRIBUTE}]`,
];

/**
 * Dev-mode guardrail: element subtrees at/above this many descendant elements
 * are considered "large" for the `data-apm-unmask` blast-radius warning.
 */
const UNMASK_SUBTREE_WARN_ELEMENTS = 24;

/** Layout containers whose presence in the unmask ancestry always warrants a warning. */
const LAYOUT_CONTAINER_TAGS: ReadonlySet<string> = new Set([
  'HTML',
  'BODY',
  'MAIN',
  'SECTION',
  'ARTICLE',
  'ASIDE',
  'NAV',
  'HEADER',
  'FOOTER',
  'FORM',
]);

/** Compose the base block list with app-supplied extra selectors (tighten-only). */
export function buildBlockSelector(extraBlock?: readonly string[]): string {
  const extras = (extraBlock ?? [])
    .map((selector) => (typeof selector === 'string' ? selector.trim() : ''))
    .filter((selector) => selector.length > 0);
  return [...BASE_BLOCK_SELECTORS, ...extras].join(',');
}

/**
 * Collapse any content-bearing value to the fixed {@link MASKED_TOKEN}.
 * Whitespace-only / empty values pass through unchanged so masking never
 * fabricates visible content where there was none.
 */
function maskToToken(value: string): string {
  return /\S/.test(value) ? MASKED_TOKEN : value;
}

// Ambient declaration so we can reference `process.env.NODE_ENV` literally
// (required for bundler inlining) without depending on @types/node — this is a
// browser SDK whose build tsconfig has no node types. Mirrors `config.ts`.
declare const process: { env: Record<string, string | undefined> } | undefined;

function isDevMode(): boolean {
  try {
    return typeof process !== 'undefined' && process?.env?.NODE_ENV !== 'production';
  } catch {
    return false;
  }
}

// One warning per offending unmask element per session — never spam.
const warnedUnmaskElements = new WeakSet<Element>();

/**
 * ⚠️ BLAST-RADIUS GUARDRAIL for `data-apm-unmask`.
 *
 * `maskText` uses `element.closest(UNMASK_SELECTOR)`, so `data-apm-unmask` on
 * ANY ancestor unmasks EVERY text node in that ancestor's subtree. A single
 * attribute on `<main>` or a layout wrapper therefore exposes all rendered text
 * in the app. This emits a dev-mode `console.warn` when the unmask sits on a
 * large subtree or a layout container.
 *
 * WARN-ONLY, by design: we never fail closed here (that would re-mask a region
 * a pilot deliberately unmasked and silently break their intent). The warning
 * is a nudge, not an enforcement.
 */
function warnOnLargeUnmask(unmaskEl: Element): void {
  if (!isDevMode()) {
    return;
  }
  try {
    if (warnedUnmaskElements.has(unmaskEl)) {
      return;
    }
    const descendantCount =
      typeof unmaskEl.querySelectorAll === 'function' ? unmaskEl.querySelectorAll('*').length : 0;
    const isLayoutContainer = LAYOUT_CONTAINER_TAGS.has(unmaskEl.tagName);
    if (descendantCount < UNMASK_SUBTREE_WARN_ELEMENTS && !isLayoutContainer) {
      return;
    }
    warnedUnmaskElements.add(unmaskEl);
    // eslint-disable-next-line no-console
    console.warn(
      `[@nais/apm] data-apm-unmask on <${unmaskEl.tagName.toLowerCase()}> unmasks its entire subtree ` +
        `(${descendantCount} descendant element(s)). Every text node inside is captured UNMASKED into ` +
        `session replay. Move the attribute to the smallest leaf element that needs to be visible.`
    );
  } catch {
    // The guardrail must never break masking — fail silent (still masks).
  }
}

/**
 * rrweb `maskTextFn`: masks all text unless the owning element carries (or is
 * inside an element carrying) the `data-apm-unmask` allowlist attribute.
 *
 * Masked text collapses to the fixed {@link MASKED_TOKEN} (not a per-character
 * map) so length/word-shape does not leak.
 */
export function maskText(text: string, element: HTMLElement | null): string {
  try {
    if (element && typeof element.closest === 'function') {
      const unmaskEl = element.closest(UNMASK_SELECTOR);
      if (unmaskEl !== null) {
        warnOnLargeUnmask(unmaskEl);
        return text;
      }
    }
  } catch {
    // Any DOM weirdness falls through to masking — fail closed.
  }
  return maskToToken(text);
}

/**
 * rrweb `maskInputFn`: input values ALWAYS mask (no unmask path — inputs are
 * never allowlisted) and collapse to the fixed {@link MASKED_TOKEN}, so input
 * masking is not length-preserving either.
 */
export function maskInput(value: string, _element: HTMLElement): string {
  return maskToToken(value);
}

/** Masking fragment for `rrweb.record()`. Frozen: attempts to override throw. */
export interface RecordMaskingOptions {
  readonly maskAllInputs: true;
  readonly maskTextSelector: '*';
  readonly maskTextFn: typeof maskText;
  readonly maskInputFn: typeof maskInput;
  readonly blockSelector: string;
  readonly inlineStylesheet: false;
  readonly inlineImages: false;
  readonly recordCanvas: false;
  readonly collectFonts: false;
  readonly slimDOMOptions: true;
}

/** Masking fragment for `rrweb-snapshot`'s `snapshot()`. Frozen. */
export interface SnapshotMaskingOptions {
  readonly maskAllInputs: true;
  readonly maskTextSelector: '*';
  readonly maskTextFn: typeof maskText;
  readonly maskInputFn: typeof maskInput;
  readonly blockSelector: string;
  readonly inlineStylesheet: false;
  readonly inlineImages: false;
  readonly recordCanvas: false;
  readonly slimDOM: true;
}

/**
 * Build the record-time masking floor. `extraBlock` selectors are appended to
 * the base block list; nothing can be relaxed. Spread this LAST into rrweb
 * `record()` options so it always wins.
 */
export function buildRecordMaskingOptions(extraBlock?: readonly string[]): RecordMaskingOptions {
  return Object.freeze({
    maskAllInputs: true,
    maskTextSelector: '*',
    maskTextFn: maskText,
    maskInputFn: maskInput,
    blockSelector: buildBlockSelector(extraBlock),
    inlineStylesheet: false,
    inlineImages: false,
    recordCanvas: false,
    collectFonts: false,
    slimDOMOptions: true,
  } as const);
}

/** Build the snapshot-time masking floor (same rules, snapshot option names). */
export function buildSnapshotMaskingOptions(extraBlock?: readonly string[]): SnapshotMaskingOptions {
  return Object.freeze({
    maskAllInputs: true,
    maskTextSelector: '*',
    maskTextFn: maskText,
    maskInputFn: maskInput,
    blockSelector: buildBlockSelector(extraBlock),
    inlineStylesheet: false,
    inlineImages: false,
    recordCanvas: false,
    slimDOM: true,
  } as const);
}
