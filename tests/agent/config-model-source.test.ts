import { describe, expect, test } from 'bun:test';
import { resolveModel, resolveModelWithSource } from '../../src/agent/config';
import { getBackendDefaultModel } from '../../src/backend/defaults';
import type { GlobalConfig } from '../../src/agent/config';

/**
 * Source-aware resolution must report the exact same model as resolveModel
 * for every input, plus the correct source layer. This is the gate that
 * protects the resolveModel refactor: any divergence between the projection
 * and the source-aware result fails here.
 */
describe('resolveModelWithSource', () => {
  test('explicit model wins and is labeled explicit', () => {
    const r = resolveModelWithSource({ backend: 'codex', explicitModel: 'gpt-9' });
    expect(r.model).toBe('gpt-9');
    expect(r.source).toBe('explicit');
  });

  test('per-backend config override beats global MODEL', () => {
    const globalConfig: GlobalConfig = {
      model: 'gpt-5.6-sol',
      backendModels: { codex: 'gpt-5.2' },
    };
    const r = resolveModelWithSource({ backend: 'codex', globalConfig });
    expect(r.model).toBe('gpt-5.2');
    expect(r.source).toBe('backend-config');
  });

  test('global raw model applies to prefix-compatible backend', () => {
    const globalConfig: GlobalConfig = { model: 'gpt-5.6-sol' };
    const r = resolveModelWithSource({ backend: 'codex', globalConfig });
    expect(r.model).toBe('gpt-5.6-sol');
    expect(r.source).toBe('global-config');
  });

  test('global raw model does not leak to a foreign backend', () => {
    const globalConfig: GlobalConfig = { model: 'gpt-5.6-sol' };
    const r = resolveModelWithSource({ backend: 'pi', globalConfig });
    // gpt- is codex-prefixed; falls through to pi's built-in default.
    expect(r.model).toBe(getBackendDefaultModel('pi'));
    expect(r.source).toBe('built-in');
  });

  test('global alias applies only to its target backend', () => {
    const globalConfig: GlobalConfig = { model: 'sol' }; // alias → codex/gpt-5.6-sol
    const onCodex = resolveModelWithSource({ backend: 'codex', globalConfig });
    expect(onCodex.model).toBe('gpt-5.6-sol');
    expect(onCodex.source).toBe('global-config');

    const onPi = resolveModelWithSource({ backend: 'pi', globalConfig });
    expect(onPi.model).toBe(getBackendDefaultModel('pi'));
    expect(onPi.source).toBe('built-in');
  });

  test('unprefixed global model is portable across backends', () => {
    const globalConfig: GlobalConfig = { model: 'some-custom-model' };
    const r = resolveModelWithSource({ backend: 'agy', globalConfig });
    expect(r.model).toBe('some-custom-model');
    expect(r.source).toBe('global-config');
  });

  test('no config falls back to built-in default', () => {
    const r = resolveModelWithSource({ backend: 'agy' });
    expect(r.model).toBe(getBackendDefaultModel('agy'));
    expect(r.source).toBe('built-in');
  });

  test('resolveModel is a pure projection of resolveModelWithSource', () => {
    const cases: Array<{ backend: string; explicitModel?: string; globalConfig?: GlobalConfig }> = [
      { backend: 'codex', explicitModel: 'gpt-9' },
      { backend: 'codex', globalConfig: { model: 'gpt-5.6-sol', backendModels: { codex: 'gpt-5.2' } } },
      { backend: 'pi', globalConfig: { model: 'gpt-5.6-sol' } },
      { backend: 'codex', globalConfig: { model: 'sol' } },
      { backend: 'agy' },
      { backend: 'droid', globalConfig: { model: 'claude-fable-5' } },
    ];
    for (const c of cases) {
      expect(resolveModel(c)).toBe(resolveModelWithSource(c).model);
    }
  });
});
