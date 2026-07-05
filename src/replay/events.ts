/**
 * Events tier — the safe-default session-replay privacy tier
 * (nais/grafana-apm-app#82).
 *
 * Derives a lightweight INTERACTION TIMELINE from DOM events and ships it as
 * ordinary Faro events (`kind=event`, the A2 approach) — there is deliberately
 * NO rrweb import on this path, so no rrweb ever lands in the safe-path bundle,
 * and NO FullSnapshot / DOM node tree is ever produced. Structurally there is
 * nothing to leak beyond URLs, which are run through `scrubUrl` first.
 *
 * Each event carries ONLY:
 *   - the target element's tag name and ARIA `role` (never id/class/text),
 *   - click coordinates (rounded viewport px),
 *   - a timestamp.
 *
 * It NEVER captures text content, input/form values, element ids, or a node
 * tree. The one negative guarantee the events tier makes is the absence of the
 * DOM.
 *
 * Trigger semantics mirror `recording.ts`:
 *   - `mode: 'on-error'` (default): the timeline is buffered in a bounded
 *     in-memory ring; nothing is sent until the first captured error, at which
 *     point the buffer is flushed and the collector switches to streaming.
 *   - `mode: 'always'`: every event is pushed as it happens.
 */

import { scrubUrl } from '../scrub.js';

import { hashString } from './hash.js';

/** Faro event names for the events-tier timeline. The plugin reader keys off these. */
export const EVENTS_NAVIGATION = 'faro.session_events.navigation';
export const EVENTS_CLICK = 'faro.session_events.click';
export const EVENTS_RAGE_CLICK = 'faro.session_events.rage_click';
export const EVENTS_SCROLL = 'faro.session_events.scroll';
export const EVENTS_ERROR = 'faro.session_events.error';

/** Rage-click heuristic: N clicks within a small radius and time window. */
const RAGE_CLICK_COUNT = 3;
const RAGE_CLICK_RADIUS_PX = 30;
const RAGE_CLICK_WINDOW_MS = 1_000;

/** Coarse scroll sampling: at most one scroll event this often. */
const SCROLL_THROTTLE_MS = 500;

/** Bounded ring buffer for on-error mode (oldest dropped past the cap). */
const MAX_BUFFERED_EVENTS = 200;

/** Sink for one timeline event; in production this wraps `faro.api.pushEvent`. */
export type PushEvent = (name: string, attributes: Record<string, string>) => void;

/**
 * Deterministic per-session sampling: the same session id always lands on the
 * same side of the rate. Mirrors `recording.ts` so a session is either fully
 * captured or not at all. (Kept local to avoid pulling the rrweb-adjacent
 * recording module onto the events path.)
 */
export function isSessionSampled(sessionId: string | undefined, sampleRate: number): boolean {
  if (!(sampleRate > 0)) {
    return false;
  }
  if (sampleRate >= 1) {
    return true;
  }
  if (sessionId === undefined || sessionId === '') {
    return Math.random() < sampleRate;
  }
  return hashString(sessionId) / 0x1_0000_0000 < sampleRate;
}

export interface EventsHandle {
  /**
   * Notify the collector that an error was captured. In `on-error` mode the
   * first call flushes the buffered timeline, marks the error position, and
   * switches to streaming; later calls only push an error marker.
   */
  notifyError(): void;
  /** Stop collecting and remove all listeners / history patches. */
  stop(): void;
  /** True once events are streaming (always-mode, or after the first error). */
  readonly isStreaming: boolean;
}

export interface StartEventsOptions {
  mode: 'on-error' | 'always';
  /** Fraction of sessions captured, 0..1. Default 1. */
  sampleRate?: number;
  push: PushEvent;
  /** Faro session id, used for deterministic sampling. */
  sessionId?: string;
  /** @internal test seam: clock. */
  now?: () => number;
}

/** Extract the privacy-safe descriptor of an event target: tag + role only. */
function describeTarget(target: EventTarget | null): { tag: string; role?: string } {
  try {
    const element = target as Element | null;
    if (!element || typeof element.tagName !== 'string') {
      return { tag: 'unknown' };
    }
    const out: { tag: string; role?: string } = { tag: element.tagName.toLowerCase() };
    const role = element.getAttribute?.('role');
    if (role) {
      out.role = role;
    }
    return out;
  } catch {
    return { tag: 'unknown' };
  }
}

/**
 * Attach an events-tier error breadcrumb to the timeline WITHOUT any DOM node
 * tree: a text-free marker carrying the current (scrubbed) URL and viewport.
 * Used by `screenshotOnError` when the resolved tier is not `dom`.
 */
export function pushErrorBreadcrumb(push: PushEvent): void {
  try {
    if (typeof window === 'undefined') {
      return;
    }
    push(EVENTS_ERROR, {
      url: scrubUrl(window.location?.href ?? ''),
      w: String(window.innerWidth || 0),
      h: String(window.innerHeight || 0),
      t: String(Date.now()),
    });
  } catch {
    // A breadcrumb must never break error reporting.
  }
}

/**
 * Start the events-tier collector. Returns `undefined` when running outside a
 * browser or the session is sampled out; never throws.
 */
export function startEventsCollection(options: StartEventsOptions): EventsHandle | undefined {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }
    if (!isSessionSampled(options.sessionId, options.sampleRate ?? 1)) {
      return undefined;
    }

    const now = options.now ?? (() => Date.now());
    const { push } = options;

    let streaming = options.mode === 'always';
    let stopped = false;
    const buffer: Array<{ name: string; attributes: Record<string, string> }> = [];

    const record = (name: string, attributes: Record<string, string>): void => {
      if (stopped) {
        return;
      }
      if (streaming) {
        push(name, attributes);
        return;
      }
      buffer.push({ name, attributes });
      if (buffer.length > MAX_BUFFERED_EVENTS) {
        buffer.shift();
      }
    };

    const emitNavigation = (): void => {
      record(EVENTS_NAVIGATION, {
        url: scrubUrl(window.location?.href ?? ''),
        t: String(now()),
      });
    };

    // Rage-click detector: clicks kept only while within the radius + window of
    // the latest click; once the streak reaches the threshold, emit one derived
    // event and reset.
    let clickStreak: Array<{ x: number; y: number }> = [];
    let lastClickTs = 0;

    const onClick = (event: Event): void => {
      try {
        const mouse = event as MouseEvent;
        const x = Math.round(mouse.clientX ?? 0);
        const y = Math.round(mouse.clientY ?? 0);
        const t = now();
        const target = describeTarget(event.target);
        const base: Record<string, string> = { tag: target.tag, x: String(x), y: String(y), t: String(t) };
        if (target.role) {
          base['role'] = target.role;
        }
        record(EVENTS_CLICK, base);

        if (t - lastClickTs > RAGE_CLICK_WINDOW_MS) {
          clickStreak = [];
        }
        lastClickTs = t;
        clickStreak = clickStreak.filter((c) => Math.hypot(c.x - x, c.y - y) <= RAGE_CLICK_RADIUS_PX);
        clickStreak.push({ x, y });
        if (clickStreak.length >= RAGE_CLICK_COUNT) {
          const rage: Record<string, string> = { ...base, count: String(clickStreak.length) };
          record(EVENTS_RAGE_CLICK, rage);
          clickStreak = [];
        }
      } catch {
        // A single bad event must never break the host app.
      }
    };

    let lastScrollTs = 0;
    const onScroll = (): void => {
      try {
        const t = now();
        if (t - lastScrollTs < SCROLL_THROTTLE_MS) {
          return;
        }
        lastScrollTs = t;
        record(EVENTS_SCROLL, {
          x: String(Math.round(window.scrollX || 0)),
          y: String(Math.round(window.scrollY || 0)),
          t: String(t),
        });
      } catch {
        // ignore
      }
    };

    // Navigation: SPA route changes go through history.pushState/replaceState;
    // back/forward and hash routing fire popstate/hashchange.
    const history = window.history;
    const originalPushState = history?.pushState;
    const originalReplaceState = history?.replaceState;
    if (history && typeof originalPushState === 'function') {
      history.pushState = function patchedPushState(this: History, ...args: Parameters<History['pushState']>) {
        const result = originalPushState.apply(this, args);
        emitNavigation();
        return result;
      };
    }
    if (history && typeof originalReplaceState === 'function') {
      history.replaceState = function patchedReplaceState(this: History, ...args: Parameters<History['replaceState']>) {
        const result = originalReplaceState.apply(this, args);
        emitNavigation();
        return result;
      };
    }

    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', emitNavigation);
    window.addEventListener('hashchange', emitNavigation);
    window.addEventListener('scroll', onScroll, { passive: true });

    // Seed the timeline with the entry URL.
    emitNavigation();

    return {
      get isStreaming(): boolean {
        return streaming;
      },
      notifyError(): void {
        try {
          if (!streaming) {
            streaming = true;
            const buffered = buffer.splice(0, buffer.length);
            for (const item of buffered) {
              push(item.name, item.attributes);
            }
          }
          // Mark the error position in the timeline (text-free).
          pushErrorBreadcrumb(push);
        } catch {
          // ignore
        }
      },
      stop(): void {
        if (stopped) {
          return;
        }
        stopped = true;
        try {
          document.removeEventListener('click', onClick, true);
          window.removeEventListener('popstate', emitNavigation);
          window.removeEventListener('hashchange', emitNavigation);
          window.removeEventListener('scroll', onScroll);
          if (history && typeof originalPushState === 'function') {
            history.pushState = originalPushState;
          }
          if (history && typeof originalReplaceState === 'function') {
            history.replaceState = originalReplaceState;
          }
        } catch {
          // ignore
        }
      },
    };
  } catch {
    return undefined;
  }
}
