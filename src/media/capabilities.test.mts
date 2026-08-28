// Tests for model-capability resolution and spec validation
// (capabilities.ts).
//
// Run: npx tsx src/imagegen/capabilities.test.mts
//
// The load-bearing property here is the FALLBACK: when nothing is known
// about a model, every spec must pass. A catalog outage that turns into
// a tool refusing valid input would be worse than no validation at all,
// so the permissive cases below are the ones to keep an eye on.

import assert from 'node:assert/strict';
import type { ImageModel, OpenAiCompatibleProvider } from '../config/types.ts';
import {
  applyDefaults,
  clearCatalogCache,
  listCatalogModels,
  resolveCapabilities,
  validateSpecs,
} from './capabilities.ts';
import type { ModelCapabilities } from '../imagegen/types.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const provider: OpenAiCompatibleProvider = {
  engine: 'openai-compatible',
  baseUrl: 'https://example.test/api/v1',
  apiKey: 'k',
  models: [{ id: 'x', contextWindow: 1, capabilities: ['text'] }],
} as unknown as OpenAiCompatibleProvider;

function model(overrides: Partial<ImageModel> = {}): ImageModel {
  return {
    name: 'testmodel',
    provider: 'p',
    model: 'vendor/testmodel',
    endpoint: '/images',
    capabilitiesEndpoint: '/images/models',
    defaults: {},
    ...overrides,
  } as ImageModel;
}

const unknownCaps: ModelCapabilities = { known: false, source: 'unknown', values: {} };

// ── applyDefaults ───────────────────────────────────────────────────

check(
  'defaults: fill in what caller omitted',
  applyDefaults({}, model({ defaults: { resolution: '1K', aspect_ratio: '16:9' } })).resolution ===
    '1K',
);
check(
  'defaults: caller wins field by field',
  applyDefaults(
    { resolution: '2K' },
    model({ defaults: { resolution: '1K', aspect_ratio: '16:9' } }),
  ).resolution === '2K',
);
check(
  'defaults: untouched fields still filled',
  applyDefaults(
    { resolution: '2K' },
    model({ defaults: { resolution: '1K', aspect_ratio: '16:9' } }),
  ).aspect_ratio === '16:9',
);
check('defaults: no defaults configured is a no-op', Object.keys(applyDefaults({}, model())).length === 0);

// ── validateSpecs: the permissive path ──────────────────────────────

check(
  'validate: unknown capabilities reject nothing',
  validateSpecs({ resolution: '8K', aspect_ratio: '13:7', quality: 'ultra' }, unknownCaps, 'M')
    .length === 0,
);
check(
  'validate: a field with no known values passes',
  validateSpecs({ quality: 'whatever' }, { known: true, source: 'catalog', values: { resolution: ['1K'] } }, 'M')
    .length === 0,
);
check(
  'validate: empty allow-list is treated as unknown, not as deny-all',
  validateSpecs({ resolution: '2K' }, { known: true, source: 'catalog', values: { resolution: [] } }, 'M')
    .length === 0,
);

// ── validateSpecs: the enforcing path ───────────────────────────────

const grokCaps: ModelCapabilities = {
  known: true,
  source: 'catalog',
  values: { resolution: ['1K', '2K'], aspect_ratio: ['1:1', '16:9'], quality: ['low', 'medium'] },
  maxN: 4,
  maxReferences: 3,
};

check('validate: allowed value passes', validateSpecs({ resolution: '2K' }, grokCaps, 'M').length === 0);
const resErr = validateSpecs({ resolution: '4K' }, grokCaps, 'Grok Imagine 2.0');
check('validate: disallowed value rejected', resErr.length === 1);
check(
  'validate: message names the model',
  resErr[0]?.includes('Grok Imagine 2.0') === true,
  resErr[0],
);
check(
  'validate: message lists what IS allowed',
  resErr[0]?.includes('1K, 2K') === true,
  resErr[0],
);
check(
  'validate: case-insensitive tier match',
  validateSpecs({ resolution: '2k' }, grokCaps, 'M').length === 0,
);
check(
  'validate: several problems reported together',
  validateSpecs({ resolution: '4K', aspect_ratio: '21:9' }, grokCaps, 'M').length === 2,
);

// n and numeric bounds
check('validate: n within max passes', validateSpecs({ n: 4 }, grokCaps, 'M').length === 0);
check('validate: n over max rejected', validateSpecs({ n: 5 }, grokCaps, 'M').length === 1);
check(
  'validate: n message names the ceiling',
  validateSpecs({ n: 9 }, grokCaps, 'M')[0]?.includes('max 4') === true,
);
check('validate: n zero rejected', validateSpecs({ n: 0 }, grokCaps, 'M').length === 1);
check('validate: n fractional rejected', validateSpecs({ n: 1.5 }, grokCaps, 'M').length === 1);
check(
  'validate: n unbounded when max unknown',
  validateSpecs({ n: 99 }, unknownCaps, 'M').length === 0,
);
check(
  'validate: compression in range',
  validateSpecs({ output_compression: 80 }, unknownCaps, 'M').length === 0,
);
check(
  'validate: compression out of range rejected',
  validateSpecs({ output_compression: 101 }, unknownCaps, 'M').length === 1,
);

// ── resolveCapabilities: config override ────────────────────────────

clearCatalogCache();
const fromConfig = await resolveCapabilities(
  'p',
  provider,
  model({ allow: { resolution: ['1K', '2K'], maxN: 2, maxReferences: 3 } }),
);
check('resolve: config override reports its source', fromConfig.source === 'config');
check('resolve: config values used', fromConfig.values.resolution?.join() === '1K,2K');
check('resolve: config maxN used', fromConfig.maxN === 2);

// ── resolveCapabilities: catalog ────────────────────────────────────

const realFetch = globalThis.fetch;
function stubFetch(payload: unknown, ok = true): void {
  globalThis.fetch = (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }) as unknown as Response) as typeof fetch;
}

clearCatalogCache();
stubFetch({
  data: [
    { id: 'vendor/testmodel', resolutions: ['1K', '2K'], aspect_ratios: ['1:1', '16:9'], max_images: 4 },
    { id: 'vendor/other', resolutions: ['4K'] },
  ],
});
const fromCatalog = await resolveCapabilities('p', provider, model());
check('resolve: catalog reports its source', fromCatalog.source === 'catalog');
check('resolve: flat keys read', fromCatalog.values.resolution?.join() === '1K,2K');
check('resolve: aspect ratios read', fromCatalog.values.aspect_ratio?.join() === '1:1,16:9');
check('resolve: maxN read', fromCatalog.maxN === 4);
check('resolve: other models not mixed in', fromCatalog.values.resolution?.includes('4K') !== true);

// The real OpenRouter shape, copied verbatim from
// GET /api/v1/images/models on 2026-08-26. `supported_parameters` maps
// a field to {type:'enum', values} or {type:'range', min, max} — not to
// a bare array, which is what the first pass at this parser assumed.
const OPENROUTER_GROK = {
  id: 'x-ai/grok-imagine-image-2.0',
  name: 'xAI: Grok Imagine Image 2.0',
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
  supported_parameters: {
    resolution: { type: 'enum', values: ['1K', '2K'] },
    aspect_ratio: {
      type: 'enum',
      values: ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', 'auto'],
    },
    quality: { type: 'enum', values: ['low', 'medium'] },
    n: { type: 'range', min: 1, max: 1 },
    input_references: { type: 'range', min: 0, max: 3 },
  },
  supports_streaming: false,
};

clearCatalogCache();
stubFetch({ data: [OPENROUTER_GROK] });
const real = await resolveCapabilities('p', provider, model({ model: 'x-ai/grok-imagine-image-2.0' }));
check('openrouter: resolutions read', real.values.resolution?.join() === '1K,2K', JSON.stringify(real.values.resolution));
check('openrouter: aspect ratios read', real.values.aspect_ratio?.length === 8, String(real.values.aspect_ratio?.length));
check('openrouter: qualities read', real.values.quality?.join() === 'low,medium');
check('openrouter: n range becomes maxN', real.maxN === 1, String(real.maxN));
check('openrouter: reference range becomes maxReferences', real.maxReferences === 3, String(real.maxReferences));
check(
  'openrouter: unlisted spec stays unconstrained',
  real.values.output_format === undefined,
);
// This model renders one image per call — asking for four has to fail
// before the request goes out, not after it's billed.
check('openrouter: n=4 rejected against a max of 1', validateSpecs({ n: 4 }, real, 'Grok').length === 1);
check('openrouter: n=1 accepted', validateSpecs({ n: 1 }, real, 'Grok').length === 0);
check('openrouter: 4K rejected', validateSpecs({ resolution: '4K' }, real, 'Grok').length === 1);
check('openrouter: 2K accepted', validateSpecs({ resolution: '2K' }, real, 'Grok').length === 0);
check(
  'openrouter: high quality rejected with the list',
  validateSpecs({ quality: 'high' }, real, 'Grok')[0]?.includes('low, medium') === true,
);

// The parameter list is exhaustive, so a field missing from it is
// unsupported — NOT merely unconstrained. grok-imagine takes no
// output_format, no background and no seed.
check('openrouter: supported list captured', real.supported?.join() === 'resolution,aspect_ratio,quality,n,input_references', String(real.supported));
check(
  'openrouter: unsupported field rejected',
  validateSpecs({ output_format: 'png' }, real, 'Grok').length === 1,
);
check(
  'openrouter: rejection names what the model does take',
  validateSpecs({ seed: 42 }, real, 'Grok')[0]?.includes('resolution, aspect_ratio') === true,
  validateSpecs({ seed: 42 }, real, 'Grok')[0],
);
check(
  'openrouter: supported field with no value list still passes',
  validateSpecs({ n: 1 }, real, 'Grok').length === 0,
);
// A default written for another model must not break every call to
// this one — it is skipped, not applied and then rejected.
const withDefaults = applyDefaults({}, model({ defaults: { output_format: 'png', resolution: '2K' } }), real);
check('defaults: unsupported default skipped', withDefaults.output_format === undefined);
check('defaults: supported default still applied', withDefaults.resolution === '2K');
check('defaults: skipping keeps the call valid', validateSpecs(withDefaults, real, 'Grok').length === 0);
// Without a published list nothing is rejected — unknown is not "no".
check(
  'unknown caps: no field is considered unsupported',
  validateSpecs({ output_format: 'png', seed: 1, background: 'transparent' }, unknownCaps, 'M').length === 0,
);

// Nested payloads — catalogs commonly group parameters one level down.
clearCatalogCache();
stubFetch({
  data: [{ id: 'vendor/testmodel', parameters: { supported_resolutions: ['512', '1K'] } }],
});
const nested = await resolveCapabilities('p', provider, model());
check('resolve: nested container read', nested.values.resolution?.join() === '512,1K', JSON.stringify(nested.values));

// Catalog answers but doesn't list this model → permissive, not empty.
clearCatalogCache();
stubFetch({ data: [{ id: 'someone/else' }] });
const missing = await resolveCapabilities('p', provider, model());
check('resolve: unlisted model is unknown, not denied', missing.known === false);
check('resolve: unlisted model has no constraints', Object.keys(missing.values).length === 0);
check(
  'resolve: unlisted model validates permissively',
  validateSpecs({ resolution: '8K' }, missing, 'M').length === 0,
);

// Catalog unreachable → same permissive outcome.
clearCatalogCache();
globalThis.fetch = (async () => {
  throw new Error('ECONNREFUSED');
}) as typeof fetch;
const offline = await resolveCapabilities('p', provider, model());
check('resolve: unreachable catalog is unknown', offline.known === false);
check(
  'resolve: unreachable catalog validates permissively',
  validateSpecs({ resolution: '4K', n: 10 }, offline, 'M').length === 0,
);

// An unrecognizable payload must degrade the same way.
clearCatalogCache();
stubFetch({ something: 'unexpected' });
const weird = await resolveCapabilities('p', provider, model());
check('resolve: unexpected payload shape is unknown', weird.known === false);

// capabilitiesEndpoint: null → never even asks.
clearCatalogCache();
let called = false;
globalThis.fetch = (async () => {
  called = true;
  throw new Error('should not be called');
}) as typeof fetch;
const noEndpoint = await resolveCapabilities('p', provider, model({ capabilitiesEndpoint: null }));
check('resolve: null endpoint skips the fetch', !called);
check('resolve: null endpoint is unknown', noEndpoint.known === false);

// listCatalogModels for the UI picker.
clearCatalogCache();
stubFetch({ data: [{ id: 'a/one', name: 'One' }, { id: 'b/two' }] });
const listed = await listCatalogModels('p', provider, '/images/models');
check('list: returns catalog ids', listed.map((m) => m.id).join() === 'a/one,b/two');
check('list: carries names when present', listed[0]?.name === 'One');
check('list: tolerates missing names', listed[1]?.name === undefined);

clearCatalogCache();
globalThis.fetch = (async () => {
  throw new Error('offline');
}) as typeof fetch;
check('list: empty when catalog unreachable', (await listCatalogModels('p', provider, '/x')).length === 0);

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0, `${fail} capability test(s) failed`);
