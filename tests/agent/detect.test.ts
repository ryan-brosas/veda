/**
 * Regression tests for agy detection in veda init (src/agent/detect.ts).
 * The reviewer found that init's harness detection predated the backend
 * registry and listed only four backends; agy must be detectable and must
 * pick gemini-3.1-pro-high when it is the only (or winning) harness.
 */

import { describe, expect, test } from 'bun:test';
import { pickDefaultModel, type DetectedBackend } from '../../src/agent/detect';

describe('pickDefaultModel with agy', () => {
  test('agy alone picks gemini-3.1-pro-high via the agy backend', () => {
    const backends: DetectedBackend[] = [{ name: 'agy', command: 'agy' }];
    expect(pickDefaultModel(backends)).toEqual({
      model: 'gemini-3.1-pro-high',
      backend: 'agy',
    });
  });

  test('detection priority puts agy last: codex still wins when both exist', () => {
    const backends: DetectedBackend[] = [
      { name: 'codex', command: 'codex' },
      { name: 'agy', command: 'agy' },
    ];
    expect(pickDefaultModel(backends)?.backend).toBe('codex');
  });

  test('agy beats nothing: empty list yields undefined', () => {
    expect(pickDefaultModel([])).toBeUndefined();
  });
});
