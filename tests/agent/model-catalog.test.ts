import { describe, expect, test } from 'bun:test';
import {
  familyKey,
  groupIntoFamilies,
  parseCodexCatalog,
  parseAgyModels,
  parseDroidCustomModels,
  parsePiCatalog,
  collectAliases,
  collectModels,
  type CatalogModel,
} from '../../src/agent/model-catalog';

// =============================================================================
// familyKey — the grouping heuristic the example proved fragile
// =============================================================================

describe('familyKey', () => {
  test('strips org prefix and lowercases', () => {
    expect(familyKey('moonshotai/Kimi-K2.6')).toBe('kimi-k2.6');
    expect(familyKey('kimi-k2.6')).toBe('kimi-k2.6');
  });

  test('strips hf: prefix', () => {
    expect(familyKey('hf:moonshotai/Kimi-K2.6')).toBe('kimi-k2.6');
  });

  test('strips a single trailing variant suffix', () => {
    expect(familyKey('kimi-k2.6-fast')).toBe('kimi-k2.6');
    expect(familyKey('glm-5.1-long')).toBe('glm-5.1');
  });

  test('strips longest suffix first (short-fast before short)', () => {
    expect(familyKey('glm-5.2-short-fast')).toBe('glm-5.2');
    expect(familyKey('glm-5.2-short')).toBe('glm-5.2');
  });

  test('collapses case duplicates to one family', () => {
    expect(familyKey('Kimi-K2.6')).toBe(familyKey('kimi-k2.6'));
  });

  test('unknown / suffix-only shapes stay singleton', () => {
    expect(familyKey('conductor')).toBe('conductor');
    expect(familyKey('-fast')).toBe('-fast'); // never produces empty key
  });
});

// =============================================================================
// groupIntoFamilies — pure, deterministic, lossless under expansion
// =============================================================================

describe('groupIntoFamilies', () => {
  test('collapses variants under first-seen head with variantCount', () => {
    const rows: CatalogModel[] = [
      { id: 'pi/neuralwatt/moonshotai/Kimi-K2.6', source: 'pi-config' },
      { id: 'pi/neuralwatt/kimi-k2.6-fast', source: 'pi-config' },
      { id: 'pi/neuralwatt/kimi-k2.6-long', source: 'pi-config' },
      { id: 'pi/neuralwatt/kimi-k3', source: 'pi-config' },
    ];
    const heads = groupIntoFamilies(rows);
    expect(heads).toHaveLength(2);
    expect(heads[0].id).toBe('pi/neuralwatt/moonshotai/Kimi-K2.6');
    expect(heads[0].variantCount).toBe(2);
    expect(heads[1].id).toBe('pi/neuralwatt/kimi-k3');
    expect(heads[1].variantCount).toBe(0);
  });

  test('is provider-agnostic; provider-locality is applied by the pi collector', () => {
    // groupIntoFamilies collapses by familyKey regardless of provider. The pi
    // collector (groupPiProviderLocal) groups within each provider FIRST, which
    // is what keeps pi/neuralwatt/kimi-k3 and pi/hyper/kimi-k3 distinct. This
    // test pins the low-level behavior; the collector test pins the invariant.
    const rows: CatalogModel[] = [
      { id: 'pi/neuralwatt/kimi-k3', source: 'pi-config' },
      { id: 'pi/hyper/kimi-k3', source: 'pi-config' },
    ];
    expect(groupIntoFamilies(rows)).toHaveLength(1);
  });

  test('does not mutate input rows', () => {
    const rows: CatalogModel[] = [{ id: 'a-fast', source: 'curated' }];
    groupIntoFamilies(rows);
    expect(rows[0].variantCount).toBeUndefined();
  });
});

// =============================================================================
// parseCodexCatalog
// =============================================================================

describe('parseCodexCatalog', () => {
  test('keeps only visibility=list, sorts by priority asc with stable ties', () => {
    const catalog = {
      models: [
        { slug: 'hidden-1', visibility: 'hide', priority: 1 },
        { slug: 'b-model', visibility: 'list', priority: 7, display_name: 'B' },
        { slug: 'a-model', visibility: 'list', priority: 1, display_name: 'A' },
        { slug: 'c-model', visibility: 'list', priority: 1 },
        { slug: '', visibility: 'list', priority: 0 },
        { visibility: 'list', priority: 2 },
      ],
    };
    const rows = parseCodexCatalog(catalog);
    expect(rows.map(r => r.id)).toEqual(['a-model', 'c-model', 'b-model']);
    expect(rows[0].displayName).toBe('A');
  });

  test('returns [] on malformed input', () => {
    expect(parseCodexCatalog(undefined)).toEqual([]);
    expect(parseCodexCatalog({})).toEqual([]);
    expect(parseCodexCatalog({ models: 'nope' })).toEqual([]);
  });
});

// =============================================================================
// parseAgyModels
// =============================================================================

describe('parseAgyModels', () => {
  test('parses tab-separated slug + display name, skips noise', () => {
    const out = 'Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n\nclaude-sonnet-4-6\n';
    const rows = parseAgyModels(out);
    expect(rows.map(r => r.id)).toEqual(['gemini-3.1-pro-high', 'gpt-oss-120b-medium', 'claude-sonnet-4-6']);
    expect(rows[0].displayName).toBe('Gemini 3.1 Pro (High)');
    expect(rows[2].displayName).toBeUndefined();
  });

  test('empty output yields []', () => {
    expect(parseAgyModels('')).toEqual([]);
  });
});

// =============================================================================
// parseDroidCustomModels — the secret-whitelist boundary
// =============================================================================

describe('parseDroidCustomModels', () => {
  test('whitelists id + displayName only; never leaks baseUrl/apiKey', () => {
    const settings = {
      customModels: [
        { model: 'synthetic-glm-5.1', id: 'custom:Synthetic-GLM-5.1-0', displayName: 'Synthetic GLM 5.1', baseUrl: 'http://x', apiKey: 'SECRET', provider: 'generic' },
        { model: 'noprefix', id: 'NoPrefix-2', displayName: 'No Prefix', apiKey: 'SECRET2' },
        { model: 'noid', displayName: 'No ID', apiKey: 'SECRET3' },
      ],
    };
    const rows = parseDroidCustomModels(settings);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe('custom:Synthetic-GLM-5.1-0');
    expect(rows[0].custom).toBe(true);
    expect(rows[1].id).toBe('custom:NoPrefix-2'); // prefix normalized
    // No row may carry the secret fields.
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toContain('SECRET');
      expect(JSON.stringify(r)).not.toContain('baseUrl');
      expect(JSON.stringify(r)).not.toContain('http://x');
    }
  });

  test('malformed input yields []', () => {
    expect(parseDroidCustomModels(undefined)).toEqual([]);
    expect(parseDroidCustomModels({ customModels: {} })).toEqual([]);
  });
});

// =============================================================================
// parsePiCatalog
// =============================================================================

describe('parsePiCatalog', () => {
  test('emits canonical pi/<provider>/<id> rows, marked configured', () => {
    const cfg = {
      providers: {
        neuralwatt: { models: [{ id: 'kimi-k3', name: 'Kimi K3' }, { id: 'glm-5.2' }] },
        hyper: { models: [{ id: 'kimi-k3' }] },
      },
    };
    const rows = parsePiCatalog(cfg);
    expect(rows.map(r => r.id)).toEqual(['pi/neuralwatt/kimi-k3', 'pi/neuralwatt/glm-5.2', 'pi/hyper/kimi-k3']);
    expect(rows[0].displayName).toBe('Kimi K3');
    expect(rows.every(r => r.configured)).toBe(true);
  });

  test('missing providers yields []', () => {
    expect(parsePiCatalog({})).toEqual([]);
    expect(parsePiCatalog(undefined)).toEqual([]);
  });
});

// =============================================================================
// collectAliases — user aliases override built-ins
// =============================================================================

describe('collectAliases', () => {
  test('returns aliases for the backend with origin tags', () => {
    const aliases = collectAliases('codex');
    const names = aliases.map(a => a.name);
    expect(names).toContain('sol');
    expect(names).toContain('terra');
    expect(names).toContain('luna');
    expect(aliases.find(a => a.name === 'sol')?.origin).toBe('built-in');
  });

  test('user alias overrides built-in of the same name', () => {
    const user = { sol: { backend: 'codex', model: 'gpt-custom', reasoning: 'high' } };
    const aliases = collectAliases('codex', user);
    const sol = aliases.find(a => a.name === 'sol');
    expect(sol?.model).toBe('gpt-custom');
    expect(sol?.origin).toBe('user');
  });

  test('pi has no built-in aliases; user MODEL_ALIASES supply them', () => {
    // glm/k3 are user-set, so a bare pi collectAliases returns only user aliases.
    expect(collectAliases('pi')).toEqual([]);
    const user = {
      glm: { backend: 'pi', model: 'pi/makora/zai-org/GLM-5.2-NVFP4', reasoning: 'xhigh' },
      k3: { backend: 'pi', model: 'pi/neuralwatt/kimi-k3', reasoning: 'max' },
    };
    const aliases = collectAliases('pi', user);
    expect(aliases.map(a => a.name).sort()).toEqual(['glm', 'k3']);
    expect(aliases.every(a => a.origin === 'user')).toBe(true);
  });
});

// =============================================================================
// collectModels — orchestration, caps, dedupe, scoped expansion, refresh
// =============================================================================

function piConfigFixture() {
  return JSON.stringify({
    providers: {
      neuralwatt: { models: [
        { id: 'moonshotai/Kimi-K2.6' }, { id: 'kimi-k2.6-fast' }, { id: 'kimi-k2.6-long' },
        { id: 'kimi-k3' }, { id: 'glm-5.1' }, { id: 'glm-5.1-fast' }, { id: 'glm-5.2' },
      ] },
      hyper: { models: [{ id: 'kimi-k3' }, { id: 'glm-5.2' }] },
    },
  });
}

describe('collectModels', () => {
  const noProbes = {
    isInstalled: () => true,
    probeCodex: async () => undefined,
    probeAgy: async () => undefined,
  };

  test('default (unscoped) caps pi heads at 5 and labels pi-config/partial', async () => {
    const readFile = (p: string) => (p.endsWith('.pi/agent/models.json') ? piConfigFixture() : undefined);
    const result = await collectModels({ json: false, refresh: false }, undefined, { ...noProbes, readFile });
    const pi = result.backends.find(b => b.backend === 'pi')!;
    expect(pi.models.length).toBeLessThanOrEqual(5);
    expect(pi.catalogSource).toBe('pi-config');
    expect(pi.completeness).toBe('partial');
    expect(pi.totalCatalogModels).toBeGreaterThan(pi.models.length);
    expect(pi.omittedCatalogModels).toBe(pi.totalCatalogModels - pi.models.length);
  });

  test('scoped pi expands the lossless inventory (no cap)', async () => {
    const readFile = (p: string) => (p.endsWith('.pi/agent/models.json') ? piConfigFixture() : undefined);
    const result = await collectModels({ backend: 'pi', json: false, refresh: false }, undefined, { ...noProbes, readFile });
    const pi = result.backends[0];
    // Provider-local grouping: neuralwatt 7 rows → kimi-k2.6(+2), kimi-k3,
    // glm-5.1(+1), glm-5.2 = 4 heads; hyper 2 rows → kimi-k3, glm-5.2 kept
    // SEPARATE (different provider) = 2 heads. Lossless scoped total = 6.
    expect(pi.omittedCatalogModels).toBe(0);
    expect(pi.models.length).toBe(6);
    const providers = pi.models.map(m => m.id.split('/')[1]);
    expect(providers.filter(p => p === 'neuralwatt').length).toBe(4);
    expect(providers.filter(p => p === 'hyper').length).toBe(2);
  });

  test('missing pi config → unavailable catalog, default still shown', async () => {
    const readFile = () => undefined;
    const result = await collectModels({ backend: 'pi', json: false, refresh: false }, undefined, { ...noProbes, readFile });
    const pi = result.backends[0];
    expect(pi.catalogSource).toBe('unavailable');
    expect(pi.models).toEqual([]);
    expect(pi.defaultModel.model).toBeDefined();
  });

  test('malformed pi config → warning + unavailable, does not throw', async () => {
    const readFile = (p: string) => (p.endsWith('.pi/agent/models.json') ? '{not json' : undefined);
    const result = await collectModels({ backend: 'pi', json: false, refresh: false }, undefined, { ...noProbes, readFile });
    const pi = result.backends[0];
    expect(pi.catalogSource).toBe('unavailable');
    expect(pi.warnings.some(w => /malformed/i.test(w))).toBe(true);
  });

  test('unscoped --refresh emits the claude/droid no-probe note', async () => {
    const readFile = () => undefined;
    const result = await collectModels({ json: false, refresh: true }, undefined, { ...noProbes, readFile });
    expect(result.refreshed).toBe(true);
    expect(result.warnings.some(w => /live refresh applies to codex and agy/i.test(w))).toBe(true);
  });

  test('agy refresh falls back to curated when probe fails', async () => {
    const readFile = () => undefined;
    const result = await collectModels({ backend: 'agy', json: false, refresh: true }, undefined, { ...noProbes, readFile });
    const agy = result.backends[0];
    expect(agy.catalogSource).toBe('curated');
    expect(agy.models.length).toBeGreaterThan(0);
    expect(agy.warnings.some(w => /probe failed/i.test(w))).toBe(true);
  });

  test('agy refresh uses live data on success', async () => {
    const readFile = () => undefined;
    const probeAgy = async () => 'gemini-9-new\tGemini 9 New\n';
    const result = await collectModels({ backend: 'agy', json: false, refresh: true }, undefined, { isInstalled: () => true, probeAgy, readFile });
    const agy = result.backends[0];
    expect(agy.catalogSource).toBe('live');
    expect(agy.completeness).toBe('complete');
    expect(agy.models[0].id).toBe('gemini-9-new');
  });

  test('droid dedupes custom + builtin heads and never leaks settings secrets', async () => {
    const readFile = (p: string) =>
      p.endsWith('.factory/settings.json')
        ? JSON.stringify({ customModels: [{ id: 'custom:X-0', displayName: 'X', apiKey: 'SECRET' }] })
        : undefined;
    const result = await collectModels({ backend: 'droid', json: false, refresh: false }, undefined, { ...noProbes, readFile });
    const droid = result.backends[0];
    expect(JSON.stringify(droid)).not.toContain('SECRET');
    // Alias target (fable → claude-fable-5) is injected first so it stays visible;
    // customs lead the remaining rows ahead of curated built-in heads.
    expect(droid.models[0].id).toBe('claude-fable-5');
    const customIdx = droid.models.findIndex(m => m.id === 'custom:X-0');
    const builtinIdx = droid.models.findIndex(m => m.id === 'claude-opus-4-8');
    expect(customIdx).toBeGreaterThan(-1);
    expect(builtinIdx).toBeGreaterThan(-1);
    expect(customIdx).toBeLessThan(builtinIdx);
    expect(droid.completeness).toBe('partial');
  });

  test('claude-code is curated and refresh notes no live probe', async () => {
    const readFile = () => undefined;
    const result = await collectModels({ backend: 'claude-code', json: false, refresh: true }, undefined, { ...noProbes, readFile });
    const claude = result.backends[0];
    expect(claude.catalogSource).toBe('curated');
    expect(claude.warnings.some(w => /no live model discovery/i.test(w))).toBe(true);
  });
});
