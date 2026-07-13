/**
 * Cross-repo contract test (nais/grafana-apm-app#134): the fixtures below are
 * the VERBATIM `nais.js` payloads naiserator renders — copied from its golden
 * file `pkg/resourcecreator/testdata/frontend_config.yaml` — dynamically
 * imported exactly the way an SSR server imports the mounted module. If
 * naiserator changes the template without bumping/coordinating the contract,
 * or the SDK stops accepting a shape naiserator emits, this test fails.
 *
 * When updating: paste the new golden-file string, don't hand-edit the shape.
 */
import { describe, expect, it } from 'vitest';

import { fromNaisConfig } from './config.js';
import type { NaisGeneratedConfig } from './config.js';

/** naiserator@main (pre nais/naiserator#687): schemaVersion-less payload. */
const NAIS_JS_V0 =
  "\nexport default {\n\ttelemetryCollectorURL: 'http://telemetry-collector',\n\tapp: {\n\t\tname: 'myapplication',\n\t\tversion: '1.2.3'\n\t}\n};\n";

/**
 * nais/naiserator#687 (post adversarial review): the completed schemaVersion 1
 * contract. The module wraps the SAME marshalled JSON as nais.json —
 * `export default <json>;` — one escaped serialization backs both formats.
 */
const NAIS_JS_V1 =
  'export default {\n\t"schemaVersion": 1,\n\t"telemetryCollectorURL": "http://telemetry-collector",\n\t"app": {\n\t\t"name": "myapplication",\n\t\t"namespace": "mynamespace",\n\t\t"version": "1.2.3"\n\t},\n\t"environment": "mycluster"\n};\n';

async function importNaisJs(source: string): Promise<NaisGeneratedConfig> {
  const module = (await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(source)}`
  )) as { default: NaisGeneratedConfig };
  return module.default;
}

describe('naiserator generatedConfig contract', () => {
  it('accepts the current (pre-#687) payload naiserator ships today', async () => {
    expect(fromNaisConfig(await importNaisJs(NAIS_JS_V0))).toEqual({
      app: 'myapplication',
      version: '1.2.3',
      telemetryUrl: 'http://telemetry-collector',
    });
  });

  it('accepts the completed schemaVersion 1 payload (#687)', async () => {
    expect(fromNaisConfig(await importNaisJs(NAIS_JS_V1))).toEqual({
      app: 'myapplication',
      namespace: 'mynamespace',
      version: '1.2.3',
      environment: 'mycluster',
      telemetryUrl: 'http://telemetry-collector',
    });
  });
});
