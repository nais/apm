/**
 * `<NaisMetaTags />` — render the nais config meta tags from the pod's runtime
 * environment (nais/grafana-apm-app#133 phase 2). Server-rendered so the
 * browser-side `init()` resolves app/team/cluster/version/collector with zero
 * hand-written tags.
 *
 * Usage:
 *   - Next.js Pages Router: inside `<Head>` in `_document.tsx`
 *   - Next.js App Router: inside the `<head>` element of the root layout
 *     (a server component — the env read happens on the server)
 *   - Any other React SSR: wherever the document head is rendered
 */

import * as React from 'react';

import { getNaisMetaTags } from '../metaTags.js';
import type { ConfigOptions, NaisGeneratedConfig } from '../config.js';

export interface NaisMetaTagsProps {
  /** Explicit values that win over the generatedConfig payload and the pod env. */
  overrides?: ConfigOptions;
  /**
   * The naiserator generatedConfig payload, when the server imports the
   * mounted module (`await import(mountPath)`) and prefers it over raw env.
   */
  naisConfig?: NaisGeneratedConfig;
}

export function NaisMetaTags({ overrides, naisConfig }: NaisMetaTagsProps): React.ReactElement {
  return (
    <>
      {getNaisMetaTags(overrides, naisConfig).map(({ name, content }) => (
        <meta key={name} name={name} content={content} />
      ))}
    </>
  );
}
