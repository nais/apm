/**
 * Session-replay option normalization (nais/grafana-apm-app#82 — replay privacy).
 *
 * Resolves the privacy *tier* independently of the capture *trigger* (`mode`):
 *
 *   - `mode`  ('on-error' | 'always') is the CAPTURE TRIGGER — unchanged. It
 *     decides *when* the timeline is shipped, not *what* is captured.
 *   - `tier`  ('events' | 'wireframe' | 'dom') is the PRIVACY TIER — new. It
 *     decides *what* is captured: an interaction timeline with no DOM (`events`,
 *     the safe default), a coarse wireframe (`wireframe`, Phase 3), or the full
 *     masked DOM recording (`dom`, personvernombud-gated).
 *
 * `enabled:true` with `tier` omitted resolves to `events` — a BREAKING (preview)
 * change from the old masked-DOM default, so the affected pilots get a one-time
 * deprecation warning telling them how to keep DOM capture.
 *
 * Kept out of the eager `config.ts`/`index.ts` bundle path proper: it is only
 * reached from init()'s replay branch and carries no heavy imports.
 */

/** Privacy tier: what is captured. */
export type ReplayTier = 'events' | 'wireframe' | 'dom';
/** Capture trigger: when the timeline is shipped. Unchanged semantics. */
export type ReplayTrigger = 'on-error' | 'always';

/** PREVIEW `sessionReplay` option shape accepted by `init()`. */
export interface SessionReplayOptions {
  enabled?: boolean;
  /** Privacy tier (default `events`). Distinct from `mode`. */
  tier?: ReplayTier;
  /** Capture trigger: 'on-error' (default) buffers until an error; 'always' streams. */
  mode?: ReplayTrigger;
  /** Fraction of sessions recorded, 0..1 (default 1). */
  sampleRate?: number;
  /** Extra CSS selectors to block entirely (tighten-only; DOM tier). */
  block?: string[];
}

export interface NormalizedSessionReplay {
  enabled: boolean;
  tier: ReplayTier;
  mode: ReplayTrigger;
  sampleRate?: number;
  block?: string[];
}

const VALID_TIERS: readonly ReplayTier[] = ['events', 'wireframe', 'dom'];
const DEFAULT_TIER: ReplayTier = 'events';

const DEFAULT_TIER_DEPRECATION =
  "[@nais/apm] session replay now defaults to the events tier (no DOM); " +
  "pass tier:'dom' to keep DOM capture (requires personvernombud sign-off).";

let warnedDefaultTier = false;

/** @internal test helper — resets the one-time default-tier deprecation warning. */
export function _resetSessionReplayWarningForTesting(): void {
  warnedDefaultTier = false;
}

/**
 * Normalize the raw `sessionReplay` option into a resolved shape: apply the
 * default tier, validate the tier enum (unknown → `events` + warn), and emit a
 * one-time deprecation warning when an ENABLED replay relies on the new events
 * default (the masked-DOM behavior change). Never throws.
 */
export function normalizeSessionReplay(
  options: SessionReplayOptions | undefined
): NormalizedSessionReplay {
  const enabled = options?.enabled === true;
  const requestedTier = options?.tier;

  let tier: ReplayTier;
  if (requestedTier === undefined) {
    tier = DEFAULT_TIER;
    // The default flipped from masked-DOM to the events tier. Only warn when a
    // replay is actually enabled — that is the config whose behavior changed.
    if (enabled && !warnedDefaultTier) {
      warnedDefaultTier = true;
      // eslint-disable-next-line no-console
      console.warn(DEFAULT_TIER_DEPRECATION);
    }
  } else if (VALID_TIERS.includes(requestedTier)) {
    tier = requestedTier;
  } else {
    tier = DEFAULT_TIER;
    // eslint-disable-next-line no-console
    console.warn(
      `[@nais/apm] unknown session replay tier ${JSON.stringify(requestedTier)}; ` +
        `falling back to the '${DEFAULT_TIER}' tier.`
    );
  }

  return {
    enabled,
    tier,
    mode: options?.mode === 'always' ? 'always' : 'on-error',
    sampleRate: options?.sampleRate,
    block: options?.block,
  };
}
