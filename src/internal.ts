/** @internal Shared module state between init() and the Sentry-compat API. */

import type { Faro } from '@grafana/faro-web-sdk';

interface ApmState {
  faro: Faro | undefined;
  /** Module-level context merged into every pushError context (setTag/setContext). */
  globalContext: Record<string, string>;
  warnedNotInitialized: boolean;
  /**
   * True while an async init (initFromConfigUrl) is in flight: capture calls
   * are buffered instead of dropped, and flushed on setFaroInstance.
   */
  buffering: boolean;
  pending: Array<(faro: Faro) => void>;
}

/** Cap the pre-init buffer so a page that never finishes init can't grow it unbounded. */
const MAX_PENDING = 100;

const state: ApmState = {
  faro: undefined,
  globalContext: {},
  warnedNotInitialized: false,
  buffering: false,
  pending: [],
};

export function setFaroInstance(faro: Faro | undefined): void {
  state.faro = faro;
  state.buffering = false;
  if (faro && state.pending.length > 0) {
    const pending = state.pending;
    state.pending = [];
    for (const fn of pending) {
      fn(faro);
    }
  } else {
    state.pending = [];
  }
}

/**
 * @internal Start buffering capture calls until setFaroInstance runs. Used by
 * initFromConfigUrl so signals raised while the config fetch is in flight
 * (typically early errors) are not lost.
 */
export function startPreInitBuffering(): void {
  if (!state.faro) {
    state.buffering = true;
  }
}

/**
 * @internal Run `fn` now when initialized; buffer it when an async init is in
 * flight; otherwise fall through to the warn-once no-op path.
 */
export function runOrBuffer(fn: (faro: Faro) => void): void {
  if (state.faro) {
    fn(state.faro);
    return;
  }
  if (state.buffering) {
    if (state.pending.length < MAX_PENDING) {
      state.pending.push(fn);
    }
    return;
  }
  getFaroInstance(); // not initialized and not buffering: warn once, no-op
}

export function getFaroInstance(): Faro | undefined {
  if (!state.faro && !state.warnedNotInitialized) {
    state.warnedNotInitialized = true;
    // eslint-disable-next-line no-console
    console.warn('[@nais/apm] Called before init(); the call is a no-op. Call init() first.');
  }
  return state.faro;
}

export function isInitialized(): boolean {
  return state.faro !== undefined;
}

/** @internal Like getFaroInstance but never warns; for init()'s double-init path. */
export function getStoredFaro(): Faro | undefined {
  return state.faro;
}

export function getGlobalContext(): Record<string, string> {
  return state.globalContext;
}

/** @internal test helper */
export function _resetStateForTesting(): void {
  state.faro = undefined;
  state.globalContext = {};
  state.warnedNotInitialized = false;
  state.buffering = false;
  state.pending = [];
}
