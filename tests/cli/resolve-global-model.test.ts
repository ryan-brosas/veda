/**
 * Tests for the global-MODEL arbitration in src/cli/resolve.ts resolveBackendModel.
 * A global MODEL (raw or alias) that belongs to a different backend must not leak
 * across an explicit -b switch; the backend default takes over instead.
 */

import { describe, test, expect } from 'bun:test';
import { resolveBackendModel } from '../../src/cli/resolve';
import type { GlobalConfig } from '../../src/agent/config';

describe('resolveBackendModel global MODEL arbitration', () => {
  test('global raw model with a foreign prefix falls back to the explicit backend default', () => {
    const globalConfig: GlobalConfig = { model: 'gpt-5.6-sol' };
    const r = resolveBackendModel({ explicitBackend: 'agy', globalConfig });
    expect(r.backend).toBe('agy');
    expect(r.model).toBe('gemini-3.1-pro-high');
  });

  test('global raw model applies to the backend its prefix names', () => {
    const globalConfig: GlobalConfig = { model: 'gpt-5.6-sol' };
    const r = resolveBackendModel({ explicitBackend: 'codex', globalConfig });
    expect(r.model).toBe('gpt-5.6-sol');
  });

  test('global alias for a foreign backend falls back to the backend default', () => {
    const globalConfig: GlobalConfig = { model: 'sol' };
    const r = resolveBackendModel({ explicitBackend: 'agy', globalConfig });
    expect(r.model).toBe('gemini-3.1-pro-high');
  });

  test('global alias for the same backend keeps its raw value', () => {
    // cli/resolve.ts passes the global model through verbatim; the same-alias
    // resolution happens in agent/config.ts's resolveModel. What matters for
    // the leak guard is that the value stays inside the agy namespace.
    const globalConfig: GlobalConfig = { model: 'gemini' };
    const r = resolveBackendModel({ explicitBackend: 'agy', globalConfig });
    expect(r.model).toBe('gemini');
  });

  test('unprefixed global raw model is portable across backends', () => {
    const globalConfig: GlobalConfig = { model: 'some-custom-model' };
    const r = resolveBackendModel({ explicitBackend: 'agy', globalConfig });
    expect(r.model).toBe('some-custom-model');
  });

  test('agy/ prefix infers the agy backend without -b', () => {
    const r = resolveBackendModel({ explicitModel: 'agy/gemini-3.6-flash-low' });
    expect(r.backend).toBe('agy');
    expect(r.model).toBe('agy/gemini-3.6-flash-low');
    expect(r.source).toBe('prefix');
  });

  test('per-backend config override still wins over a foreign global model', () => {
    const globalConfig: GlobalConfig = {
      model: 'gpt-5.6-sol',
      backendModels: { agy: 'gemini-3.6-flash-high' },
    };
    const r = resolveBackendModel({ explicitBackend: 'agy', globalConfig });
    expect(r.model).toBe('gemini-3.6-flash-high');
  });
});
