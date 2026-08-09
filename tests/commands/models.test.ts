import { describe, expect, test } from 'bun:test';
import { formatModelsText } from '../../src/commands/models';
import type { ModelsResult, BackendModelCatalog } from '../../src/agent/model-catalog';

function backend(over: Partial<BackendModelCatalog>): BackendModelCatalog {
  return {
    backend: 'codex',
    installed: true,
    defaultModel: { model: 'gpt-5.6-sol', source: 'global-config' },
    aliases: [],
    models: [],
    catalogSource: 'unavailable',
    completeness: 'unavailable',
    totalCatalogModels: 0,
    omittedCatalogModels: 0,
    warnings: [],
    ...over,
  };
}

function result(backends: BackendModelCatalog[], warnings: string[] = []): ModelsResult {
  return { schemaVersion: 1, refreshed: false, backends, warnings };
}

describe('formatModelsText', () => {
  test('renders default with a human source label', () => {
    const out = formatModelsText(result([backend({})]));
    expect(out).toContain('default  gpt-5.6-sol  (global config MODEL)');
  });

  test('renders aliases with reasoning and user origin', () => {
    const out = formatModelsText(result([backend({
      aliases: [
        { name: 'sol', model: 'gpt-5.6-sol', reasoning: 'max', origin: 'built-in' },
        { name: 'flash', model: 'pi/neuralwatt/deepseek-v4-flash', origin: 'user' },
      ],
    })]));
    expect(out).toContain('sol → gpt-5.6-sol [max]');
    expect(out).toContain('flash → pi/neuralwatt/deepseek-v4-flash  (your alias)');
  });

  test('renders variant-collapse and fast hints on catalog rows', () => {
    const out = formatModelsText(result([backend({
      models: [{ id: 'claude-opus-4-8', source: 'curated', variantCount: 5, fast: true }],
      catalogSource: 'curated',
      completeness: 'partial',
    })]));
    expect(out).toContain('claude-opus-4-8 (+5 variants) (fast available)');
    expect(out).toContain('(curated · partial)');
  });

  test('shows overflow pointer to the scoped view', () => {
    const out = formatModelsText(result([backend({
      models: [{ id: 'a', source: 'pi-config' }],
      catalogSource: 'pi-config',
      completeness: 'partial',
      totalCatalogModels: 6,
      omittedCatalogModels: 5,
    })]));
    expect(out).toContain('+5 more  (veda models codex for the full inventory)');
  });

  test('marks unavailable catalog and surfaces warnings', () => {
    const out = formatModelsText(result([backend({ warnings: ['codex: no local cache'] })]));
    expect(out).toContain('models   (unavailable)');
    expect(out).toContain('! codex: no local cache');
  });

  test('marks a not-installed backend', () => {
    const out = formatModelsText(result([backend({ installed: false })]));
    expect(out).toContain('codex  (not installed)');
  });

  test('refreshed header appears when refresh ran', () => {
    const r = result([backend({})]);
    r.refreshed = true;
    expect(formatModelsText(r)).toContain('models (refreshed');
  });
});
