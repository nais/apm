/**
 * Config resolution for @nais/apm (ADR-0001: docs/adr/0001-frontend-config-contract.md).
 *
 * Priority order (per field):
 *   1. Explicit `init()` options
 *   2. `<meta name="nais-app|nais-team|nais-cluster|nais-version|nais-telemetry-url">` tags
 *      (a server→browser transport rendered by the app's own server or the
 *      `@nais/apm/react` helpers — the platform never injects them)
 *   3. Environment variables — `NAIS_APP_NAME`, `NAIS_TEAM`/`NAIS_NAMESPACE`,
 *      `NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL` (pod runtime, SSR), and a version
 *      derived from `GITHUB_SHA`/`NAIS_APP_IMAGE`. In browser bundles these only
 *      work when the bundler inlines `process.env.*` — and note that
 *      `NAIS_CLUSTER_NAME` can NEVER be inlined correctly (one image deploys to
 *      many clusters); only `version` is safe to inline.
 *   4. Collector fallback derived from the cluster name (nav tenant only).
 *   5. No collector URL resolved → on a local host, console-echo dev mode
 *      (warn once); on a non-local host this is a misconfiguration and a
 *      loud, specific `console.error` is emitted instead.
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
  /**
   * Print the per-field resolution table (which source won for each field) to
   * the console. Use this to diagnose "why is nothing being sent".
   */
  debug?: boolean;
  /**
   * The tenant profile supplying last-resort collector derivation (ADR-0001
   * decision 7). Defaults to the built-in nav profile ({@link navTenant});
   * pass `false` to disable derivation entirely, or your own profile for a
   * different nais tenant. INTERIM: scheduled for demotion once the
   * platform-served well-known config URL ships (nais/grafana-apm-app#134
   * phase 3) — never rely on it for a tenant other than nav.
   */
  tenant?: TenantProfile | false;
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

/**
 * The shape of the nais platform's generated frontend config — the `nais.js`
 * module (and upcoming `nais.json`) that naiserator mounts into the pod when
 * `spec.frontend.generatedConfig` is set, with `environment`/`schemaVersion`
 * arriving as the platform contract completes (nais/grafana-apm-app#134).
 */
export interface NaisGeneratedConfig {
  /** Contract generation; absent on the original payload. */
  schemaVersion?: number;
  /** Faro collector URL for the cluster this pod runs in. */
  telemetryCollectorURL?: string;
  app?: {
    name?: string;
    /** The owning team; absent until nais/grafana-apm-app#134 phase 1 lands. */
    namespace?: string;
    version?: string;
  };
  /** Cluster/environment; absent until nais/grafana-apm-app#134 phase 1 lands. */
  environment?: string;
}

/**
 * Map the nais generated frontend config (naiserator `generatedConfig`) to
 * `init()` options. SSR servers can `import(mountPath)` the mounted module and
 * pass it through; browser apps that serve the file from their web root should
 * prefer {@link initFromConfigUrl} (which fetches and applies it in one step).
 *
 * @example
 * const naisConfig = (await import('/app/nais.js')).default;
 * init({ ...fromNaisConfig(naisConfig), namespace: 'my-team' });
 */
export function fromNaisConfig(config: NaisGeneratedConfig | null | undefined): ConfigOptions {
  if (config == null || typeof config !== 'object') {
    return {};
  }
  const options: ConfigOptions = {};
  if (config.app?.name) options.app = config.app.name;
  if (config.app?.namespace) options.namespace = config.app.namespace;
  if (config.app?.version) options.version = config.app.version;
  if (config.environment) options.environment = config.environment;
  if (config.telemetryCollectorURL) options.telemetryUrl = config.telemetryCollectorURL;
  return options;
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
 * A tenant's last-resort collector derivation (ADR-0001 decision 7). Every
 * nais tenant is a physically isolated installation (own clusters, own
 * naiserator, own top-level domain), so anything domain-shaped is per-tenant
 * knowledge and lives behind this interface — never in the shared resolution
 * code. The tenant-agnostic paths (meta tags, generatedConfig, env) always
 * win; a profile only fires when nothing else resolved.
 */
export interface TenantProfile {
  /** Short tenant name, used in debug/source labels (e.g. `'nav'`). */
  name: string;
  /** Derive the collector URL from a cluster name (e.g. `prod-gcp`). */
  telemetryUrlFromCluster?(cluster: string): string | undefined;
  /**
   * Derive the collector URL from the page's hostname. Only consulted on
   * non-local hosts. This is what makes bare `init({ app, namespace })` send
   * telemetry from a static bundle when no runtime channel is wired up yet.
   */
  telemetryUrlFromHostname?(hostname: string): string | undefined;
}

const NAV_PROD_COLLECTOR = 'https://telemetry.nav.no/collect';
const NAV_DEV_COLLECTOR = 'https://telemetry.ekstern.dev.nav.no/collect';

/**
 * The built-in nav tenant profile (https://docs.nais.io/observability/frontend/).
 * Nais APM is currently installed for the nav tenant only; other tenants must
 * rely on the platform channels (meta tag / generatedConfig / env) or supply
 * their own profile. INTERIM per ADR-0001: both derivations are demoted once
 * the platform-served well-known config URL ships (nais/grafana-apm-app#134
 * phase 3, tracked with #86).
 *
 * Note: only the collector URL is derived — never `environment`. The hostname
 * cannot tell prod-gcp from prod-fss, and a fabricated cluster name is worse
 * than an absent one.
 */
export const navTenant: TenantProfile = {
  name: 'nav',
  telemetryUrlFromCluster(cluster) {
    if (cluster.startsWith('prod-')) {
      return NAV_PROD_COLLECTOR;
    }
    if (cluster.startsWith('dev-')) {
      return NAV_DEV_COLLECTOR;
    }
    return undefined;
  },
  telemetryUrlFromHostname(hostname) {
    const host = hostname.toLowerCase();
    // dev first: *.dev.nav.no also ends with .nav.no.
    if (host === 'dev.nav.no' || host.endsWith('.dev.nav.no')) {
      return NAV_DEV_COLLECTOR;
    }
    if (host === 'nav.no' || host.endsWith('.nav.no')) {
      return NAV_PROD_COLLECTOR;
    }
    return undefined;
  },
};

/**
 * True when the page is served from a genuinely local host — the only case
 * where silently entering console-echo dev mode is the right behavior. On any
 * other host a missing collector URL is a production misconfiguration and must
 * be loud (ADR-0001 decision 6).
 */
export function isLocalHost(
  hostname: string | undefined = typeof window !== 'undefined' && window.location
    ? window.location.hostname
    : undefined
): boolean {
  if (hostname === undefined) {
    // Non-browser (SSR import, tests without jsdom): treat as local — the
    // browser-side init is where the loud path matters.
    return true;
  }
  return (
    hostname === '' ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  );
}

/** A resolved field value plus the source that supplied it (for `debug`). */
type Resolution = [value: string | undefined, source: string];

function pick(...candidates: Resolution[]): Resolution {
  for (const [value, source] of candidates) {
    if (value != null) {
      return [value, source];
    }
  }
  return [undefined, 'unresolved'];
}

let warnedDevMode = false;
let warnedMissingCollector = false;
let warnedMissingNamespace = false;

/** @internal test helper — resets the once-only dev-mode and namespace warnings. */
export function _resetDevModeWarning(): void {
  warnedDevMode = false;
  warnedMissingCollector = false;
  warnedMissingNamespace = false;
}

export function resolveConfig(options: ConfigOptions = {}): ResolvedConfig {
  const envApp = safeEnv(() => process.env.NAIS_APP_NAME);
  const envCluster = safeEnv(() => process.env.NAIS_CLUSTER_NAME);
  const envNamespace =
    safeEnv(() => process.env.NAIS_TEAM) ?? safeEnv(() => process.env.NAIS_NAMESPACE);
  // The pod-runtime collector URL naiserator sets alongside generatedConfig.
  // Runtime-only (SSR); in a CI-built browser bundle it does not exist.
  const envTelemetryUrl = safeEnv(() => process.env.NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL);
  // The commit SHA is the release identity that deploy annotations carry
  // (nais/grafana-apm-app#64: the deploy-annotation action defaults to
  // github.sha), so preferring GITHUB_SHA makes app.version join deploy
  // markers and release tracking without per-team convention work. The
  // image-tag derivation stays as the fallback.
  const envSha = safeEnv(() => process.env.GITHUB_SHA);
  const envVersion = envSha ?? versionFromImage(safeEnv(() => process.env.NAIS_APP_IMAGE));

  const [app, appSource] = pick(
    [options.app, 'init option'],
    [readMeta('nais-app'), 'meta nais-app'],
    [envApp, 'env NAIS_APP_NAME']
  );
  // Accept either `nais-team` (preferred, matches the product term) or the
  // literal `nais-namespace` meta/env for teams that mirror the k8s name.
  const [resolvedNamespace, namespaceSource] = pick(
    [options.namespace, 'init option'],
    [readMeta('nais-team'), 'meta nais-team'],
    [readMeta('nais-namespace'), 'meta nais-namespace'],
    [envNamespace, 'env NAIS_TEAM/NAIS_NAMESPACE']
  );
  const [environment, environmentSource] = pick(
    [options.environment, 'init option'],
    [readMeta('nais-cluster'), 'meta nais-cluster'],
    [envCluster, 'env NAIS_CLUSTER_NAME']
  );
  const [version, versionSource] = pick(
    [options.version, 'init option'],
    [readMeta('nais-version'), 'meta nais-version'],
    [envVersion, envSha ? 'env GITHUB_SHA' : 'env NAIS_APP_IMAGE tag']
  );
  const tenant = options.tenant === false ? undefined : (options.tenant ?? navTenant);
  const hostname =
    typeof window !== 'undefined' && window.location ? window.location.hostname : undefined;
  const local = isLocalHost(hostname);

  const [telemetryUrl, telemetryUrlSource] = pick(
    [options.telemetryUrl, 'init option'],
    [readMeta('nais-telemetry-url'), 'meta nais-telemetry-url'],
    [envTelemetryUrl, 'env NAIS_FRONTEND_TELEMETRY_COLLECTOR_URL'],
    [
      environment != null ? tenant?.telemetryUrlFromCluster?.(environment) : undefined,
      `derived from cluster '${environment ?? ''}' (${tenant?.name ?? 'no'} tenant fallback)`,
    ],
    [
      // Hostname derivation only fires on real (non-local) hosts — locally the
      // console-echo dev mode is the right outcome, not a network transport.
      !local && hostname != null ? tenant?.telemetryUrlFromHostname?.(hostname) : undefined,
      `derived from hostname '${hostname ?? ''}' (${tenant?.name ?? 'no'} tenant fallback)`,
    ]
  );

  const devMode = telemetryUrl == null;

  if (options.debug) {
    // eslint-disable-next-line no-console
    console.info(
      '[@nais/apm] config resolution:\n' +
        [
          ['app', app, appSource],
          ['namespace', resolvedNamespace, namespaceSource],
          ['version', version, versionSource],
          ['environment', environment, environmentSource],
          ['telemetryUrl', telemetryUrl, telemetryUrlSource],
        ]
          .map(([field, value, source]) => `  ${field} = ${value ?? '(unresolved)'} ← ${source}`)
          .join('\n') +
        `\n  mode = ${devMode ? (local ? 'dev (console echo)' : 'MISCONFIGURED (nothing sent)') : 'sending'}`
    );
  }

  if (devMode) {
    if (local && !warnedDevMode) {
      warnedDevMode = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[@nais/apm] No telemetry collector URL resolved (no init option, nais meta tag, or NAIS_* env). ' +
          'Running in dev mode: telemetry is echoed to the console and nothing is sent.'
      );
    } else if (!local && !warnedMissingCollector) {
      warnedMissingCollector = true;
      // This page is served from a real (non-local) host with no collector —
      // a misconfiguration, not local development. Be loud and specific
      // (ADR-0001 decision 6): name what is missing, what will not flow, and
      // how to fix it. Never throw — that would take down the host app.
      // eslint-disable-next-line no-console
      console.error(
        '[@nais/apm] No telemetry collector URL resolved on a non-local host — telemetry will NOT be sent. ' +
          'Fix one of: pass init({ telemetryUrl }), serve a <meta name="nais-telemetry-url"> tag, ' +
          'or mount the nais generatedConfig into your web root and use initFromConfigUrl(). ' +
          'Diagnose with init({ debug: true }). https://github.com/nais/apm#configuration-resolution'
      );
    }
  }

  // Team (namespace) is required for the plugin to attribute telemetry. We do
  // NOT throw — a thrown init() would take down the host app — so we loud-warn
  // (error in prod, warn in dev/console mode) and fall back to 'unknown-team'.
  if (resolvedNamespace == null && !warnedMissingNamespace) {
    warnedMissingNamespace = true;
    const message =
      '[@nais/apm] namespace (team) is required — telemetry cannot be attributed to your team and ' +
      'will be grouped under "unknown-team". Fix one of: pass init({ namespace }), serve a ' +
      '<meta name="nais-team"> tag, or set the NAIS_TEAM env.';
    // eslint-disable-next-line no-console
    (devMode && local ? console.warn : console.error)(message);
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
