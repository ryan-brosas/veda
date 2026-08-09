import { describe, expect, test } from 'bun:test';
import {
  AgyBackend,
  createAgyBackend,
  toAgyEffort,
  toAgyPermissionArgs,
  toAgyModel,
  agySlugEncodesEffort,
  buildAgyInput,
  buildAgyRunArgs,
  buildAgyResumeArgs,
  normalizeAgyEvent,
  parseAgyStream,
} from '../../src/backend/agy';
import type { Message } from '../../src/backend/types';
import { extractText, getSessionId, getUsage } from '../../src/backend/types';

// ---------------------------------------------------------------------------
// Pure mappers
// ---------------------------------------------------------------------------

describe('toAgyEffort', () => {
  test('maps minimal to low (agy has no off)', () => {
    expect(toAgyEffort('minimal')).toBe('low');
  });

  test('maps low to low', () => {
    expect(toAgyEffort('low')).toBe('low');
  });

  test('maps medium to medium', () => {
    expect(toAgyEffort('medium')).toBe('medium');
  });

  test('maps high to high', () => {
    expect(toAgyEffort('high')).toBe('high');
  });

  test('clamps xhigh to high', () => {
    expect(toAgyEffort('xhigh')).toBe('high');
  });

  test('clamps max to high', () => {
    expect(toAgyEffort('max')).toBe('high');
  });
});

describe('toAgyPermissionArgs', () => {
  test('read-only adds no flags', () => {
    expect(toAgyPermissionArgs('read-only')).toEqual([]);
  });

  test('workspace-write adds no flags (agy auto-allows workspace writes)', () => {
    expect(toAgyPermissionArgs('workspace-write')).toEqual([]);
  });

  test('full adds --dangerously-skip-permissions', () => {
    expect(toAgyPermissionArgs('full')).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('toAgyModel', () => {
  test('strips the agy/ routing prefix', () => {
    expect(toAgyModel('agy/gemini-3.1-pro-high')).toBe('gemini-3.1-pro-high');
  });

  test('passes bare slugs through untouched', () => {
    expect(toAgyModel('gemini-3.6-flash-medium')).toBe('gemini-3.6-flash-medium');
    expect(toAgyModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// Prompt and argv construction
// ---------------------------------------------------------------------------

describe('buildAgyInput', () => {
  test('orders system, context, prompt with blank-line separators', () => {
    const input = buildAgyInput('do the thing', 'file contents', 'be terse');
    expect(input).toBe(
      '<system_instructions>\nbe terse\n</system_instructions>\n\nfile contents\n\ndo the thing'
    );
  });

  test('omits the system block when systemPrompt is empty', () => {
    const input = buildAgyInput('do the thing', 'file contents', '');
    expect(input).toBe('file contents\n\ndo the thing');
  });

  test('omits context when undefined', () => {
    const input = buildAgyInput('do the thing', undefined, 'be terse');
    expect(input).toBe('<system_instructions>\nbe terse\n</system_instructions>\n\ndo the thing');
  });

  test('prompt alone has no wrapping', () => {
    expect(buildAgyInput('just this')).toBe('just this');
  });
});

const runConfig = {
  model: 'agy/gemini-3.1-pro-high',
  reasoning: 'high' as const,
  sandbox: 'read-only' as const,
};

describe('buildAgyRunArgs', () => {
  test('builds headless stream-json argv with stripped model and mapped effort', () => {
    const args = buildAgyRunArgs('input text', runConfig);
    // gemini-3.1-pro-high is capability-suffixed: its effort is in the slug,
    // so --effort must be omitted (agy rejects the combination).
    expect(args).toEqual([
      '-p', 'input text',
      '--output-format', 'stream-json',
      '--model', 'gemini-3.1-pro-high',
    ]);
  });

  test('unsuffixed slugs still get --effort', () => {
    const args = buildAgyRunArgs('x', { ...runConfig, model: 'agy/claude-sonnet-4-6' });
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  test('agySlugEncodesEffort detects capability suffixes', () => {
    expect(agySlugEncodesEffort('gemini-3.1-pro-high')).toBe(true);
    expect(agySlugEncodesEffort('gpt-oss-120b-medium')).toBe(true);
    expect(agySlugEncodesEffort('claude-sonnet-4-6')).toBe(false);
  });

  test('full sandbox appends --dangerously-skip-permissions', () => {
    const args = buildAgyRunArgs('x', { ...runConfig, sandbox: 'full' });
    expect(args.at(-1)).toBe('--dangerously-skip-permissions');
  });

  test('workspace-write appends nothing', () => {
    const args = buildAgyRunArgs('x', { ...runConfig, sandbox: 'workspace-write' });
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  test('omits --model when model is empty, still passes --effort', () => {
    const args = buildAgyRunArgs('x', { ...runConfig, model: '' });
    expect(args).not.toContain('--model');
    expect(args).toContain('--effort');
  });
});

describe('buildAgyResumeArgs', () => {
  test('uses --conversation with the explicit id, never bare -c', () => {
    const args = buildAgyResumeArgs('conv-123', 'follow up', { sandbox: 'read-only' });
    expect(args).toEqual([
      '-p', 'follow up',
      '--conversation', 'conv-123',
      '--output-format', 'stream-json',
    ]);
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });

  test('no follow-up prompt sends the literal "Continue."', () => {
    const args = buildAgyResumeArgs('conv-123', undefined, { sandbox: 'read-only' });
    expect(args[1]).toBe('Continue.');
  });

  test('blank follow-up prompt also sends "Continue."', () => {
    const args = buildAgyResumeArgs('conv-123', '   ', { sandbox: 'read-only' });
    expect(args[1]).toBe('Continue.');
  });

  test('full sandbox still applies permission flags on resume', () => {
    const args = buildAgyResumeArgs('conv-123', 'go', { sandbox: 'full' });
    expect(args).toContain('--dangerously-skip-permissions');
  });
});

// ---------------------------------------------------------------------------
// normalizeAgyEvent — fixtures derived from live captures (agy 1.1.11)
// ---------------------------------------------------------------------------

const P1_INIT = {
  event: 'init',
  conversation_id: '17d7a836-1b31-428b-9d87-fd224a10ff2f',
  init: { cwd: '/repo', tools: ['run_command'], permission_mode: 'request-review' },
};

const P1_USER_INPUT = {
  event: 'step_update',
  step_update: { conversation_id: '17d7a836', step_index: 0, state: 'DONE', step_type: 'user_input' },
};

const P1_UNKNOWN = {
  event: 'step_update',
  step_update: { conversation_id: '17d7a836', step_index: 1, state: 'DONE', step_type: 'unknown', duration_seconds: 0.000705 },
};

const P1_DELTA_ACTIVE = {
  event: 'step_update',
  step_update: { conversation_id: '17d7a836', step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'ok' },
};

const P1_DELTA_DONE = {
  event: 'step_update',
  step_update: {
    conversation_id: '17d7a836', step_index: 2, state: 'DONE', step_type: 'agent_response',
    text_delta: '\n', duration_seconds: 1.83,
    usage: { input_tokens: 19666, output_tokens: 326, thinking_tokens: 325, cache_read_tokens: 0, total_tokens: 19992 },
  },
};

const P1_CHECKPOINT = {
  event: 'step_update',
  step_update: { conversation_id: '17d7a836', step_index: 3, state: 'DONE', step_type: 'checkpoint', duration_seconds: 0.62 },
};

const P1_RESULT = {
  event: 'result',
  result: {
    conversation_id: '17d7a836-1b31-428b-9d87-fd224a10ff2f',
    status: 'SUCCESS', response: 'ok\n', duration_seconds: 2.49, num_turns: 1,
    usage: { input_tokens: 19763, output_tokens: 331, thinking_tokens: 325, cache_read_tokens: 0, total_tokens: 20094 },
  },
};

const P5_TOOL_ACTIVE = {
  event: 'step_update',
  step_update: {
    conversation_id: 'caeaa17f', step_index: 3, state: 'ACTIVE', step_type: 'tool',
    tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hello_from_agy' } },
  },
};

const P5_TOOL_ERROR = {
  event: 'step_update',
  step_update: {
    conversation_id: 'caeaa17f', step_index: 3, state: 'ERROR', step_type: 'tool',
    tool_name: 'run_command', duration_seconds: 0.21,
    tool_info: {
      name: 'run_command',
      parameters: { CommandLine: 'echo hello_from_agy' },
      error: { type: 'TOOL_ERROR', message: 'User denied permission to run command:\necho hello_from_agy' },
    },
  },
};

describe('normalizeAgyEvent', () => {
  test('init maps to init message with conversation_id as sessionId', () => {
    const msgs = normalizeAgyEvent(P1_INIT);
    expect(msgs).toEqual([{
      type: 'init',
      sessionId: '17d7a836-1b31-428b-9d87-fd224a10ff2f',
      raw: P1_INIT,
    }]);
  });

  test('agent_response deltas (ACTIVE and DONE) map to text', () => {
    expect(normalizeAgyEvent(P1_DELTA_ACTIVE)).toEqual([
      { type: 'text', content: 'ok', raw: P1_DELTA_ACTIVE },
    ]);
    expect(normalizeAgyEvent(P1_DELTA_DONE)).toEqual([
      { type: 'text', content: '\n', raw: P1_DELTA_DONE },
    ]);
  });

  test('user_input, checkpoint, and unknown step types emit nothing', () => {
    expect(normalizeAgyEvent(P1_USER_INPUT)).toEqual([]);
    expect(normalizeAgyEvent(P1_CHECKPOINT)).toEqual([]);
    expect(normalizeAgyEvent(P1_UNKNOWN)).toEqual([]);
  });

  test('tool ACTIVE emits tool_start with parameters', () => {
    expect(normalizeAgyEvent(P5_TOOL_ACTIVE)).toEqual([{
      type: 'tool_start',
      toolName: 'run_command',
      toolInput: { CommandLine: 'echo hello_from_agy' },
      raw: P5_TOOL_ACTIVE,
    }]);
  });

  test('tool ERROR emits tool_result with the error payload, not a run error', () => {
    const msgs = normalizeAgyEvent(P5_TOOL_ERROR);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('tool_result');
    expect(msgs[0].toolName).toBe('run_command');
    expect((msgs[0].toolResult as { type: string }).type).toBe('TOOL_ERROR');
  });

  test('tool DONE emits tool_result with output', () => {
    const doneStep = {
      event: 'step_update',
      step_update: {
        conversation_id: 'x', step_index: 4, state: 'DONE', step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\r\n' },
      },
    };
    expect(normalizeAgyEvent(doneStep)).toEqual([{
      type: 'tool_result',
      toolName: 'run_command',
      toolResult: 'hi\r\n',
      raw: doneStep,
    }]);
  });

  test('SUCCESS result emits done with mapped usage', () => {
    const msgs = normalizeAgyEvent(P1_RESULT);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({
      type: 'done',
      sessionId: '17d7a836-1b31-428b-9d87-fd224a10ff2f',
      usage: { inputTokens: 19763, outputTokens: 331, cachedTokens: 0 },
      raw: P1_RESULT,
    });
  });

  test('non-SUCCESS result emits error then zeroed done', () => {
    const errResult = {
      event: 'result',
      result: {
        conversation_id: '', status: 'ERROR', response: '',
        error: 'invalid model selection: model bogus is not recognized',
        duration_seconds: 0, num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
      },
    };
    const msgs = normalizeAgyEvent(errResult);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].type).toBe('error');
    expect(msgs[0].content).toContain('invalid model selection');
    expect(msgs[1].type).toBe('done');
    expect(msgs[1].usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  test('non-SUCCESS result without error field uses status in the message', () => {
    const canceled = { event: 'result', result: { conversation_id: 'c', status: 'CANCELED', response: '' } };
    const msgs = normalizeAgyEvent(canceled);
    expect(msgs[0].type).toBe('error');
    expect(msgs[0].content).toBe('agy run ended with status CANCELED');
    expect(msgs[1].type).toBe('done');
    expect(msgs[1].sessionId).toBe('c');
  });

  test('malformed events emit nothing', () => {
    expect(normalizeAgyEvent(null)).toEqual([]);
    expect(normalizeAgyEvent('string')).toEqual([]);
    expect(normalizeAgyEvent({ event: 'mystery' })).toEqual([]);
    expect(normalizeAgyEvent({ event: 'step_update' })).toEqual([]);
    expect(normalizeAgyEvent({ event: 'result' })).toEqual([]);
  });

  test('result.response is never re-emitted as text (deltas already carried it)', () => {
    const msgs = normalizeAgyEvent(P1_RESULT);
    expect(msgs.every(m => m.type !== 'text')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseAgyStream — full-history replay
// ---------------------------------------------------------------------------

function ndjsonStream(lines: unknown[]): ReadableStream<Uint8Array> {
  const text = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
}

function stderrStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      if (text) c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

async function collect(stream: AsyncIterable<Message>): Promise<Message[]> {
  const out: Message[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

describe('parseAgyStream', () => {
  test('P1 history: init, structural skips, deltas, SUCCESS done with usage', async () => {
    const msgs = await collect(parseAgyStream(
      ndjsonStream([P1_INIT, P1_USER_INPUT, P1_UNKNOWN, P1_DELTA_ACTIVE, P1_DELTA_DONE, P1_CHECKPOINT, P1_RESULT]),
      emptyStream(),
      Promise.resolve(0)
    ));
    expect(msgs.map(m => m.type)).toEqual(['init', 'text', 'text', 'done']);
    expect(extractText(msgs)).toBe('ok\n');
    expect(getSessionId(msgs)).toBe('17d7a836-1b31-428b-9d87-fd224a10ff2f');
    expect(getUsage(msgs)).toEqual({ inputTokens: 19763, outputTokens: 331, cachedTokens: 0 });
  });

  test('P5 history: tool soft-deny stays tool_result and SUCCESS still wins', async () => {
    const successResult = {
      event: 'result',
      result: {
        conversation_id: 'caeaa17f', status: 'SUCCESS', response: 'I could not run it.\n',
        duration_seconds: 5, num_turns: 1,
        usage: { input_tokens: 20000, output_tokens: 50, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20050 },
      },
    };
    const msgs = await collect(parseAgyStream(
      ndjsonStream([P5_TOOL_ACTIVE, P5_TOOL_ERROR, successResult]),
      emptyStream(),
      Promise.resolve(0)
    ));
    expect(msgs.map(m => m.type)).toEqual(['tool_start', 'tool_result', 'done']);
    expect(msgs.every(m => m.type !== 'error')).toBe(true);
  });

  test('non-SUCCESS result produces error then done, exactly one done', async () => {
    const errResult = {
      event: 'result',
      result: { conversation_id: '', status: 'ERROR', response: '', error: 'authentication failed or timed out', duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } },
    };
    const msgs = await collect(parseAgyStream(ndjsonStream([errResult]), emptyStream(), Promise.resolve(0)));
    expect(msgs.map(m => m.type)).toEqual(['error', 'done']);
    expect(msgs[0].content).toContain('authentication failed');
  });

  test('missing terminal result with stderr surfaces stderr as error', async () => {
    const msgs = await collect(parseAgyStream(
      emptyStream(),
      stderrStream('Authentication required. Please visit the URL to log in\n'),
      Promise.resolve(0)
    ));
    expect(msgs.map(m => m.type)).toEqual(['error', 'done']);
    expect(msgs[0].content).toContain('Authentication required');
  });

  test('missing terminal result without stderr but non-zero exit names the exit code', async () => {
    const msgs = await collect(parseAgyStream(emptyStream(), emptyStream(), Promise.resolve(2)));
    expect(msgs.map(m => m.type)).toEqual(['error', 'done']);
    expect(msgs[0].content).toContain('exit');
    expect(msgs[0].content).toContain('2');
  });

  test('missing terminal result, no stderr, exit 0: still loud', async () => {
    const msgs = await collect(parseAgyStream(emptyStream(), emptyStream(), Promise.resolve(0)));
    expect(msgs.map(m => m.type)).toEqual(['error', 'done']);
    expect(msgs[0].content).toContain('no terminal result');
  });

  test('events after a terminal result are ignored', async () => {
    const late = { ...P1_DELTA_ACTIVE };
    const msgs = await collect(parseAgyStream(
      ndjsonStream([P1_RESULT, late]),
      emptyStream(),
      Promise.resolve(0)
    ));
    expect(msgs.map(m => m.type)).toEqual(['done']);
  });

  test('SUCCESS is authoritative even with a non-zero exit code', async () => {
    const msgs = await collect(parseAgyStream(
      ndjsonStream([P1_RESULT]),
      emptyStream(),
      Promise.resolve(1)
    ));
    expect(msgs.map(m => m.type)).toEqual(['done']);
    expect(msgs.every(m => m.type !== 'error')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------

describe('AgyBackend', () => {
  test('has correct name and command', () => {
    const backend = new AgyBackend();
    expect(backend.name).toBe('agy');
    expect(backend.command).toBe('agy');
  });

  test('createAgyBackend returns instance', () => {
    const backend = createAgyBackend();
    expect(backend).toBeInstanceOf(AgyBackend);
    expect(backend.name).toBe('agy');
  });

  test('empty prompt yields error + done without spawning', async () => {
    const backend = new AgyBackend();
    const msgs = await collect(backend.run({
      prompt: '   ',
      config: {
        model: 'gemini-3.1-pro-high',
        reasoning: 'medium',
        sandbox: 'read-only',
        systemPrompt: '',
      },
    }));
    expect(msgs.map(m => m.type)).toEqual(['error', 'done']);
    expect(msgs[0].content).toContain('Empty prompt');
  });
});

// ---------------------------------------------------------------------------
// Registry, routing, and alias integration
// ---------------------------------------------------------------------------

describe('agy registration and routing', () => {
  test('registry knows agy after backend index import', async () => {
    const { hasBackend, listBackends, getBackend } = await import('../../src/backend/index');
    expect(hasBackend('agy')).toBe(true);
    expect(listBackends()).toContain('agy');
    expect(getBackend('agy').command).toBe('agy');
  });

  test('defaults provide model and reasoning for agy', async () => {
    const { getBackendDefaultModel, getBackendDefaultReasoning } = await import('../../src/backend/defaults');
    expect(getBackendDefaultModel('agy')).toBe('gemini-3.1-pro-high');
    expect(getBackendDefaultReasoning('agy')).toBe('medium');
  });

  test('gemini-flash alias resolves to agy with a bare slug', async () => {
    const { resolveModelAlias } = await import('../../src/agent/model-aliases');
    const target = resolveModelAlias('gemini-flash');
    expect(target).toEqual({ backend: 'agy', model: 'gemini-3.6-flash-high' });
  });

  test('gemini-pro alias resolves to agy pro default', async () => {
    const { resolveModelAlias } = await import('../../src/agent/model-aliases');
    const target = resolveModelAlias('gemini-pro');
    expect(target).toEqual({ backend: 'agy', model: 'gemini-3.1-pro-high' });
  });

  test('agy/ prefix infers the agy backend via resolveBackendModel', async () => {
    const { resolveBackendModel } = await import('../../src/agent/config');
    const resolved = resolveBackendModel({
      explicitModel: 'agy/gemini-3.6-flash-low',
      fallbackBackend: 'codex',
    });
    expect(resolved.backend).toBe('agy');
    expect(resolved.model).toBe('agy/gemini-3.6-flash-low');
  });

  test('gemini-flash alias alone selects the agy backend', async () => {
    const { resolveBackendModel } = await import('../../src/agent/config');
    const resolved = resolveBackendModel({
      explicitModel: 'gemini-flash',
      fallbackBackend: 'codex',
    });
    expect(resolved.backend).toBe('agy');
    expect(resolved.model).toBe('gemini-3.6-flash-high');
  });

  test('user-defined agy/ alias infers the agy backend', async () => {
    const { parseModelAliases } = await import('../../src/agent/model-aliases');
    const aliases = parseModelAliases('myflash=agy/gemini-3.6-flash-low:low');
    expect(aliases['myflash']).toEqual({
      backend: 'agy',
      model: 'agy/gemini-3.6-flash-low',
      reasoning: 'low',
    });
  });

  test('deep-stage resolution routes a gemini-flash solver slot to agy', async () => {
    const { resolveBackendModelForStage } = await import('../../src/agent/config');
    const resolved = resolveBackendModelForStage('solver', {
      explicitModel: 'gemini-flash',
      fallbackBackend: 'codex',
    });
    expect(resolved.backend).toBe('agy');
    expect(resolved.model).toBe('gemini-3.6-flash-high');
  });

  test('deep-stage judge default for agy backend uses the agy default model', async () => {
    const { resolveModelForStage } = await import('../../src/agent/config');
    expect(resolveModelForStage({ backend: 'agy', stage: 'judge' })).toBe('gemini-3.1-pro-high');
  });
});
