/**
 * Config resolution for @nais/apm.
 *
 * Priority order (per field):
 *   1. Explicit `init()` options
 *   2. `<meta name="nais-app|nais-cluster|nais-version|nais-telemetry-url">` tags
 *   3. Build-time environment variables (`NAIS_APP_NAME`, `NAIS_CLUSTER_NAME`,
 *      version derived from `NAIS_APP_IMAGE`) — these only work when the bundler
 *      inlines `process.env.*` (webpack DefinePlugin, Vite `define`, Next.js `env`).
 *   4. Dev fallback: no collector URL resolved → console-echo mode (warn once).
 */

export interface ConfigOptions {
  /** Application name; maps to Faro `app.name`. */
  app?: string;
  /**
   * The nais team that owns this app (a.k.a. the Kubernetes namespace); maps to
   * Faro `app.namespace`. The plugin groups and attributes all telemetry by
   * team, so this is effectively required — browser telemetry without it cannot
   * be attributed to a team. Resolves from `<meta name="nais-team">` /
   * `nais-namespace` or the `NAIS_TEAM` / `NAIS_NAMESPACE` env when omitted.
   */
  namespace?: string;
  /** Application version / release; maps to Faro `app.version`. */
  version?: string;
  /** Environment (nais cluster, e.g. `prod-gcp`); maps to Faro `app.environment`. */
  environment?: string;
  /** Faro collector URL (Alloy `faro.receiver`). */
  telemetryUrl?: string;
}

export interface ResolvedConfig {
  app: string;
  /** The nais team (namespace). Falls back to `'unknown-team'` when unresolved. */
  namespace: string;
  version?: string;
  environment?: string;
  telemetryUrl?: string;
  /** True when no collector URL could be resolved → console-echo mode. */
  devMode: boolean;
}

// Ambient declaration so we can reference `process.env.*` literally (required for
// bundler inlining) without depending on @types/node.
declare const process: { env: Record<string, string | undefined> };

/**
 * Read an environment value defensively. The callback must contain the literal
 * `process.env.NAME` expression so bundlers can substitute it; in browsers
 * without such substitution the ReferenceError is swallowed.
 */
function safeEnv(get: () => string | undefined): string | undefined {
  try {
    const value = get();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

function readMeta(name: string): string | undefined {
  if (typeof document === 'undefined') {
    return undefined;
  }
  const content = document.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
  return content == null || content === '' ? undefined : content;
}

/**
 * Derive a version from a container image reference, e.g.
 * `europe-north1-docker.pkg.dev/nais/app:2026.07.03-abc1234` → `2026.07.03-abc1234`.
 */
export function versionFromImage(image: string | undefined): string | undefined {
  if (!image) {
    return undefined;
  }
  const colon = image.lastIndexOf(':');
  if (colon === -1 || colon < image.lastIndexOf('/')) {
    return undefined; // no tag, or the colon belongs to a registry port
  }
  const tag = image.slice(colon + 1);
  return tag === '' ? undefined : tag;
}

/**
 * Well-known nais collectors, derived from the cluster name as a last resort
 * (https://docs.nais.io/observability/frontend/).
 *
 * This is a fallback below the `<meta name="nais-telemetry-url">` tag / env
 * var, which is the primary, tenant-agnostic resolution path (the platform
 * injects the correct collector URL for whichever tenant serves the app).
 * The URLs below are a nav-specific assumption: Nais APM is currently
 * installed for the nav tenant only, and this fallback hardcodes nav's
 * collector domain rather than deriving it per tenant. Keep it for now (nav
 * is the only tenant, and removing it would regress zero-config apps that
 * rely on it), but it must become tenant-aware — or be dropped in favor of
 * always requiring the injected meta tag/env — before Nais APM ships to a
 * tenant other than nav. See docs/multi-tenancy-assumptions.md in the plugin
 * repo for the full inventory.
 */
function telemetryUrlFromCluster(cluster: string | undefined): string | undefined {
  if (!cluster) {
    return undefined;
  }
  if (cluster.startsWith('prod-')) {
    return 'https://telemetry.nav.no/collect';
  }
  if (cluster.startsWith('dev-')) {
    return 'https://telemetry.ekstern.dev.nav.no/collect';
  }
  return undefined;
}

let warnedDevMode = false;
let warnedMissingNamespace = false;

/** @internal test helper — resets the once-only dev-mode and namespace warnings. */
export function _resetDevModeWarning(): void {
  warnedDevMode = false;
  warnedMissingNamespace = false;
}

export function resolveConfig(options: ConfigOptions = {}): ResolvedConfig {
  const envApp = safeEnv(() => process.env.NAIS_APP_NAME);
  const envCluster = safeEnv(() => process.env.NAIS_CLUSTER_NAME);
  const envNamespace =
    safeEnv(() => process.env.NAIS_TEAM) ?? safeEnv(() => process.env.NAIS_NAMESPACE);
  // The commit SHA is the release identity that deploy annotations carry
  // (nais/grafana-apm-app#64: the deploy-annotation action defaults to
  // github.sha), so preferring GITHUB_SHA makes app.version join deploy
  // markers and release tracking without per-team convention work. The
  // image-tag derivation stays as the fallback.
  const envSha = safeEnv(() => process.env.GITHUB_SHA);
  const envVersion = envSha ?? versionFromImage(safeEnv(() => process.env.NAIS_APP_IMAGE));

  const app = options.app ?? readMeta('nais-app') ?? envApp;
  // Accept either `nais-team` (preferred, matches the product term) or the
  // literal `nais-namespace` meta/env for teams that mirror the k8s name.
  const resolvedNamespace =
    options.namespace ?? readMeta('nais-team') ?? readMeta('nais-namespace') ?? envNamespace;
  const environment = options.environment ?? readMeta('nais-cluster') ?? envCluster;
  const version = options.version ?? readMeta('nais-version') ?? envVersion;
  const telemetryUrl =
    options.telemetryUrl ?? readMeta('nais-telemetry-url') ?? telemetryUrlFromCluster(environment);

  const devMode = telemetryUrl == null;
  if (devMode && !warnedDevMode) {
    warnedDevMode = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[@nais/apm] No telemetry collector URL resolved (no init option, nais meta tag, or NAIS_* env). ' +
        'Running in dev mode: telemetry is echoed to the console and nothing is sent.'
    );
  }

  // Team (namespace) is required for the plugin to attribute telemetry. We do
  // NOT throw — a thrown init() would take down the host app — so we loud-warn
  // (error in prod, warn in dev/console mode) and fall back to 'unknown-team'.
  if (resolvedNamespace == null && !warnedMissingNamespace) {
    warnedMissingNamespace = true;
    const message =
      '[@nais/apm] namespace (team) is required — set it via init({ namespace }), ' +
      'a <meta name="nais-team"> tag, or the NAIS_TEAM env';
    // eslint-disable-next-line no-console
    (devMode ? console.warn : console.error)(message);
  }

  return {
    app: app ?? 'unknown-app',
    namespace: resolvedNamespace ?? 'unknown-team',
    version,
    environment,
    telemetryUrl,
    devMode,
  };
}
