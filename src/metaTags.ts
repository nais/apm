/**
 * Server-side meta-tag helpers (ADR-0001 decision 3, nais/grafana-apm-app#133
 * phase 2): meta tags are the server→browser transport for frontend config,
 * authored by the app's own server from the pod's runtime environment — the
 * platform never injects them. These helpers make that authoring one line.
 *
 * Runs in Node (SSR): reads the `NAIS_*` runtime env naiserator injects into
 * every pod, plus `NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL` when
 * `spec.frontend.generatedConfig` is enabled. In the browser it returns only
 * whatever overrides were passed (there is no pod env to read).
 */

import { versionFromImage } from './config.js';
import type { ConfigOptions, NaisGeneratedConfig } from './config.js';

export interface NaisMetaTag {
  name: string;
  content: string;
}

declare const process: { env: Record<string, string | undefined> };

function env(name: string): string | undefined {
  try {
    const value = process.env[name];
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the five nais meta tags from explicit overrides, the optional
 * naiserator generatedConfig payload, and the pod's runtime env — in that
 * order. Fields that resolve to nothing are omitted (the browser-side
 * resolution chain stays responsible for fallbacks and loudness).
 *
 * @example
 * // Express: res.render('index', { naisMetaTags: renderNaisMetaTags() })
 * // Custom templating:
 * getNaisMetaTags().map(({ name, content }) => `<meta name="${name}" content="${content}">`)
 */
export function getNaisMetaTags(
  overrides: ConfigOptions = {},
  naisConfig?: NaisGeneratedConfig
): NaisMetaTag[] {
  const fromConfig = naisConfig ?? {};
  const app = overrides.app ?? fromConfig.app?.name ?? env('NAIS_APP_NAME');
  const namespace =
    overrides.namespace ??
    fromConfig.app?.namespace ??
    env('NAIS_TEAM') ??
    env('NAIS_NAMESPACE');
  const environment = overrides.environment ?? fromConfig.environment ?? env('NAIS_CLUSTER_NAME');
  // Runtime (pod) version identity: the image tag. GITHUB_SHA is a build-time
  // concept and does not exist in the pod.
  const version =
    overrides.version ?? fromConfig.app?.version ?? versionFromImage(env('NAIS_APP_IMAGE'));
  const telemetryUrl =
    overrides.telemetryUrl ??
    fromConfig.telemetryCollectorURL ??
    env('NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL');

  const tags: NaisMetaTag[] = [];
  if (app) tags.push({ name: 'nais-app', content: app });
  if (namespace) tags.push({ name: 'nais-team', content: namespace });
  if (environment) tags.push({ name: 'nais-cluster', content: environment });
  if (version) tags.push({ name: 'nais-version', content: version });
  if (telemetryUrl) tags.push({ name: 'nais-telemetry-url', content: telemetryUrl });
  return tags;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * The same tags as {@link getNaisMetaTags}, rendered as an HTML string for
 * string-based templating (Express/Handlebars/Thymeleaf-style SSR).
 */
export function renderNaisMetaTags(
  overrides: ConfigOptions = {},
  naisConfig?: NaisGeneratedConfig
): string {
  return getNaisMetaTags(overrides, naisConfig)
    .map(({ name, content }) => `<meta name="${name}" content="${escapeAttribute(content)}">`)
    .join('\n');
}
