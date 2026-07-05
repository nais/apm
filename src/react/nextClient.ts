/**
 * Next.js client initialization helper for @nais/apm (nais/grafana-apm-app#79).
 *
 * `initNaisAPMClient` is the documented entry for Next 15+
 * `instrumentation-client.ts` and the Pages Router `_app.tsx` pattern. It:
 *   - no-ops on the server (`typeof window === 'undefined'`), so it is safe to
 *     import into modules that also run in React Server Components / during SSR;
 *   - is idempotent: `init()` already self-guards against double
 *     initialization, so React StrictMode's double invoke or repeated imports
 *     return the existing Faro instance instead of re-initializing.
 */

import { init } from '../index.js';
import type { InitOptions } from '../index.js';
import type { Faro } from '@grafana/faro-web-sdk';

/**
 * Initialize @nais/apm from a Next.js client entry. Returns the Faro instance
 * in the browser, or `undefined` when called on the server (a no-op).
 *
 * ```ts
 * // instrumentation-client.ts (Next 15+)
 * import { initNaisAPMClient } from '@nais/apm/react';
 * initNaisAPMClient({ namespace: 'my-team' });
 * ```
 */
export function initNaisAPMClient(options: InitOptions = {}): Faro | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return init(options);
}
