import { describe, expect, test } from 'bun:test';
import {
  MODEL_ALIASES,
  normalizeModelName,
  resolveModelAlias,
  isModelAlias,
  listModelAliases,
  parseModelAliases,
} from '../../src/agent/model-aliases';

describe('MODEL_ALIASES', () => {
  test('contains Claude models', () => {
    expect(MODEL_ALIASES['opus']).toEqual({ backend: 'claude-code', model: 'opus' });
    expect(MODEL_ALIASES['sonnet']).toEqual({ backend: 'claude-code', model: 'sonnet' });
    expect(MODEL_ALIASES['haiku']).toEqual({ backend: 'claude-code', model: 'haiku' });
  });

  test('contains OpenAI (codex) models', () => {
    expect(MODEL_ALIASES['sol']).toEqual({ backend: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' });
    expect(MODEL_ALIASES['terra']).toEqual({ backend: 'codex', model: 'gpt-5.6-terra', reasoning: 'high' });
    expect(MODEL_ALIASES['luna']).toEqual({ backend: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' });
  });

  test('contains Droid models', () => {
    expect(MODEL_ALIASES['fable']).toEqual({ backend: 'droid', model: 'claude-fable-5' });
  });

  test('pi glm/k3 are user-set, not built-in', () => {
    expect(MODEL_ALIASES['glm']).toBeUndefined();
    expect(MODEL_ALIASES['k3']).toBeUndefined();
  });

  test('contains agy models', () => {
    expect(MODEL_ALIASES['gemini-pro']).toEqual({ backend: 'agy', model: 'gemini-3.1-pro-high' });
    expect(MODEL_ALIASES['gemini-flash']).toEqual({ backend: 'agy', model: 'gemini-3.6-flash-high' });
    expect(MODEL_ALIASES['gemini-lite']).toBeUndefined();
  });
});

describe('normalizeModelName', () => {
  test('lowercases input', () => {
    expect(normalizeModelName('OPUS')).toBe('opus');
    expect(normalizeModelName('Sonnet')).toBe('sonnet');
  });

  test('trims whitespace', () => {
    expect(normalizeModelName('  opus  ')).toBe('opus');
    expect(normalizeModelName('\thaiku\n')).toBe('haiku');
  });

  test('handles combined normalization', () => {
    expect(normalizeModelName('  OpUs  ')).toBe('opus');
    expect(normalizeModelName(' GLM ')).toBe('glm');
  });
});

describe('resolveModelAlias', () => {
  test('resolves Claude aliases', () => {
    expect(resolveModelAlias('opus')).toEqual({ backend: 'claude-code', model: 'opus' });
    expect(resolveModelAlias('sonnet')).toEqual({ backend: 'claude-code', model: 'sonnet' });
    expect(resolveModelAlias('haiku')).toEqual({ backend: 'claude-code', model: 'haiku' });
  });

  test('resolves OpenAI (codex) aliases', () => {
    expect(resolveModelAlias('sol')).toEqual({ backend: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' });
    expect(resolveModelAlias('terra')).toEqual({ backend: 'codex', model: 'gpt-5.6-terra', reasoning: 'high' });
    expect(resolveModelAlias('luna')).toEqual({ backend: 'codex', model: 'gpt-5.6-luna', reasoning: 'high' });
  });

  test('resolves Droid aliases', () => {
    expect(resolveModelAlias('fable')).toEqual({ backend: 'droid', model: 'claude-fable-5' });
  });

  test('resolves agy aliases', () => {
    expect(resolveModelAlias('gemini-pro')).toEqual({ backend: 'agy', model: 'gemini-3.1-pro-high' });
    expect(resolveModelAlias('gemini-flash')).toEqual({ backend: 'agy', model: 'gemini-3.6-flash-high' });
    expect(resolveModelAlias('gemini-lite')).toBeUndefined();
  });

  test('handles case-insensitive lookup', () => {
    expect(resolveModelAlias('OPUS')).toEqual({ backend: 'claude-code', model: 'opus' });
    expect(resolveModelAlias('Sonnet')).toEqual({ backend: 'claude-code', model: 'sonnet' });
    expect(resolveModelAlias('SOL')).toEqual({ backend: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' });
    expect(resolveModelAlias('Gemini-Pro')).toEqual({ backend: 'agy', model: 'gemini-3.1-pro-high' });
  });

  test('handles whitespace', () => {
    expect(resolveModelAlias('  opus  ')).toEqual({ backend: 'claude-code', model: 'opus' });
    expect(resolveModelAlias(' haiku\n')).toEqual({ backend: 'claude-code', model: 'haiku' });
  });

  test('returns undefined for unknown models', () => {
    expect(resolveModelAlias('unknown-model')).toBeUndefined();
    expect(resolveModelAlias('')).toBeUndefined();
  });
});

describe('isModelAlias', () => {
  test('returns true for known aliases', () => {
    expect(isModelAlias('opus')).toBe(true);
    expect(isModelAlias('sonnet')).toBe(true);
    expect(isModelAlias('haiku')).toBe(true);
    expect(isModelAlias('fable')).toBe(true);
    expect(isModelAlias('sol')).toBe(true);
    expect(isModelAlias('terra')).toBe(true);
    expect(isModelAlias('gemini-pro')).toBe(true);
  });

  test('returns false for unknown models', () => {
    expect(isModelAlias('unknown-model')).toBe(false);
    expect(isModelAlias('')).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(isModelAlias('OPUS')).toBe(true);
    expect(isModelAlias('Sonnet')).toBe(true);
    expect(isModelAlias('SOL')).toBe(true);
    expect(isModelAlias('GEMINI-FLASH')).toBe(true);
  });
});

describe('listModelAliases', () => {
  test('returns all alias names', () => {
    const aliases = listModelAliases();
    expect(aliases).toContain('opus');
    expect(aliases).toContain('sonnet');
    expect(aliases).toContain('haiku');
    expect(aliases).toContain('fable');
    expect(aliases).toContain('sol');
    expect(aliases).toContain('terra');
    expect(aliases).toContain('luna');
    expect(aliases).toContain('gemini-pro');
    expect(aliases).toContain('gemini-flash');
    // Removed / user-set names are absent.
    expect(aliases).not.toContain('gpt');
    expect(aliases).not.toContain('glm');
    expect(aliases).not.toContain('k3');
    expect(aliases).not.toContain('gemini');
    expect(aliases).not.toContain('agy-flash');
    expect(aliases).not.toContain('gemini-lite');
  });

  test('returns expected count', () => {
    // opus sonnet haiku sol terra luna fable gemini-pro gemini-flash = 9
    expect(listModelAliases().length).toBe(9);
  });
});

describe('parseModelAliases and user alias overrides', () => {
  test('parses name=model and infers pi backend from prefix', () => {
    expect(parseModelAliases('flash=pi/neuralwatt/deepseek-v4-flash')).toEqual({
      flash: { backend: 'pi', model: 'pi/neuralwatt/deepseek-v4-flash' },
    });
  });

  test('preserves colons inside the model id (hf: prefix), only reads valid reasoning', () => {
    // Regression: hf:moonshotai/Kimi-K3 must not be split on its inner colon.
    expect(parseModelAliases('k3-syn=pi/synthetic/hf:moonshotai/Kimi-K3')).toEqual({
      'k3-syn': { backend: 'pi', model: 'pi/synthetic/hf:moonshotai/Kimi-K3' },
    });
    // A valid trailing reasoning level still parses off the model.
    expect(parseModelAliases('k3-syn=pi/synthetic/hf:moonshotai/Kimi-K3:max')).toEqual({
      'k3-syn': { backend: 'pi', model: 'pi/synthetic/hf:moonshotai/Kimi-K3', reasoning: 'max' },
    });
  });

  test('preserves the full model string (parsePiModel needs the pi/ prefix)', () => {
    const aliases = parseModelAliases('flash=pi/neuralwatt/deepseek-v4-flash');
    expect(aliases.flash.model).toBe('pi/neuralwatt/deepseek-v4-flash');
  });

  test('infers codex backend from gpt- prefix with reasoning', () => {
    expect(parseModelAliases('fast=gpt-5.2:low')).toEqual({
      fast: { backend: 'codex', model: 'gpt-5.2', reasoning: 'low' },
    });
  });

  test('parses multiple comma-separated aliases (quoted in config)', () => {
    expect(parseModelAliases('flash=pi/neuralwatt/deepseek-v4-flash,fast=gpt-5.2:low')).toEqual({
      flash: { backend: 'pi', model: 'pi/neuralwatt/deepseek-v4-flash' },
      fast: { backend: 'codex', model: 'gpt-5.2', reasoning: 'low' },
    });
  });

  test('skips invalid entries without throwing', () => {
    expect(parseModelAliases('flash=pi/neuralwatt/deepseek-v4-flash,,bad,=nope,noequals,unknown=whatever')).toEqual({
      flash: { backend: 'pi', model: 'pi/neuralwatt/deepseek-v4-flash' },
    });
  });

  test('normalizes alias names to lowercase', () => {
    expect(parseModelAliases('FLASH=pi/neuralwatt/deepseek-v4-flash')).toEqual({
      flash: { backend: 'pi', model: 'pi/neuralwatt/deepseek-v4-flash' },
    });
  });

  test('user alias overrides built-in table', () => {
    const user = parseModelAliases('sol=pi/neuralwatt/deepseek-v4-flash');
    expect(resolveModelAlias('sol', user)).toEqual({ backend: 'pi', model: 'pi/neuralwatt/deepseek-v4-flash' });
  });

  test('user alias resolves without built-in fallback', () => {
    const user = parseModelAliases('spark=pi/neuralwatt/deepseek-v4-flash');
    expect(resolveModelAlias('spark', user)).toEqual({ backend: 'pi', model: 'pi/neuralwatt/deepseek-v4-flash' });
    expect(resolveModelAlias('spark')).toBeUndefined(); // not built-in
  });

  test('extra aliases appear in the alias list', () => {
    const user = parseModelAliases('spark=pi/neuralwatt/deepseek-v4-flash');
    expect(listModelAliases(user)).toContain('spark');
  });
});
