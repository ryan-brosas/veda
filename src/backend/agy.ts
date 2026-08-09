import type { Backend, Message, RunOptions, ResumeOptions } from './types';
import type { SandboxMode, ReasoningLevel } from '../agent/config';
import { spawnCliWithRetry, commandExists, parseNdjsonStream } from './util/spawn';

/**
 * Map veda ReasoningLevel → agy `--effort` value.
 * agy supports three levels: low, medium, high. The clamp is silent (droid
 * precedent): minimal|low → low, medium → medium, high|xhigh|max → high.
 * Probed 2026-08-09 (agy 1.1.11): --effort high produces thinking tokens,
 * low produces none.
 */
export function toAgyEffort(reasoning: ReasoningLevel): string {
  switch (reasoning) {
    case 'minimal':
      return 'low';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'high';
    case 'max':
      return 'high';
  }
}

/**
 * Map veda SandboxMode → agy permission flags.
 * read-only and workspace-write both use agy defaults: workspace file reads
 * and writes are auto-allowed, everything else (shell commands, URLs, MCP)
 * is soft-denied in headless mode. The boundary between the two modes is
 * thinner than on other backends. Only full adds --dangerously-skip-permissions.
 */
export function toAgyPermissionArgs(sandbox: SandboxMode): string[] {
  switch (sandbox) {
    case 'read-only':
      return [];
    case 'workspace-write':
      return [];
    case 'full':
      return ['--dangerously-skip-permissions'];
  }
}

/**
 * Strip one leading `agy/` routing prefix from a veda model string, leaving
 * the native agy slug untouched. Bare slugs pass through unchanged so typos
 * reach agy, which fails loudly with an ERROR envelope listing valid models.
 */
export function toAgyModel(model: string): string {
  return model.startsWith('agy/') ? model.slice('agy/'.length) : model;
}

/**
 * Capability-suffixed slugs (gemini-3.1-pro-high, gpt-oss-120b-medium) encode
 * their effort in the name; combining one with --effort is rejected by agy
 * (probed 2026-08-09: "--model X conflicts with --effort=Y"). Unsuffixed
 * slugs (claude-sonnet-4-6) accept --effort.
 */
export function agySlugEncodesEffort(slug: string): boolean {
  return /-(low|medium|high)$/.test(slug);
}

/**
 * Compose the single -p argument: system instructions (wrapped in
 * <system_instructions>), then context, then the user prompt. Empty sections
 * are omitted; included sections are separated by a blank line. Claude's
 * backend uses the same wrapping convention.
 */
export function buildAgyInput(
  prompt: string,
  context?: string,
  systemPrompt?: string
): string {
  const sections: string[] = [];
  if (systemPrompt) {
    sections.push(`<system_instructions>\n${systemPrompt}\n</system_instructions>`);
  }
  if (context) {
    sections.push(context);
  }
  sections.push(prompt);
  return sections.join('\n\n');
}

/**
 * Headless run arguments: agy -p <input> --output-format stream-json
 * [--model <slug>] --effort <level> [--dangerously-skip-permissions].
 */
export function buildAgyRunArgs(
  input: string,
  config: { model: string; reasoning: ReasoningLevel; sandbox: SandboxMode }
): string[] {
  const args: string[] = ['-p', input, '--output-format', 'stream-json'];
  if (config.model) {
    const slug = toAgyModel(config.model);
    args.push('--model', slug);
    if (!agySlugEncodesEffort(slug)) {
      args.push('--effort', toAgyEffort(config.reasoning));
    }
  } else {
    args.push('--effort', toAgyEffort(config.reasoning));
  }
  args.push(...toAgyPermissionArgs(config.sandbox));
  return args;
}

/**
 * Resume arguments: agy -p <follow-up|"Continue."> --conversation <id>
 * --output-format stream-json [permission args]. Model and effort are
 * omitted: the existing conversation owns those choices. Bare -c/--continue
 * is never used — it resolves through a workspace-keyed cache that races
 * under parallel pipelines.
 */
export function buildAgyResumeArgs(
  sessionId: string,
  prompt: string | undefined,
  config: { sandbox: SandboxMode }
): string[] {
  const args: string[] = [
    '-p', prompt && prompt.trim() ? prompt : 'Continue.',
    '--conversation', sessionId,
    '--output-format', 'stream-json',
  ];
  args.push(...toAgyPermissionArgs(config.sandbox));
  return args;
}

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0 };
}

/**
 * Normalize one agy NDJSON envelope into zero or more ordered veda messages.
 * An array is required because a failed result yields error followed by done.
 *
 * Wire shapes (probed against agy 1.1.11, docs/cli/headless):
 *   init:        { event:"init", conversation_id, init:{ cwd, tools[], permission_mode, model?, agent? } }
 *   step_update: { event:"step_update", step_update:{ step_index, state: ACTIVE|DONE|ERROR,
 *                  step_type: user_input|agent_response|tool|checkpoint|unknown,
 *                  text_delta?, tool_name?, tool_info?{ name, parameters, output?, error? }, usage? } }
 *   result:      { event:"result", result:{ conversation_id, status, response, error?,
 *                  duration_seconds, num_turns, usage{ input_tokens, output_tokens,
 *                  thinking_tokens, cache_read_tokens, total_tokens } } }
 */
export function normalizeAgyEvent(event: unknown): Message[] {
  if (!event || typeof event !== 'object') return [];
  const e = event as Record<string, unknown>;
  const kind = e.event as string | undefined;

  if (kind === 'init') {
    return [{
      type: 'init',
      sessionId: e.conversation_id as string | undefined,
      raw: event,
    }];
  }

  if (kind === 'step_update') {
    const step = e.step_update as Record<string, unknown> | undefined;
    if (!step) return [];
    const stepType = step.step_type as string | undefined;
    const state = step.state as string | undefined;

    if (stepType === 'agent_response') {
      const delta = step.text_delta;
      if (typeof delta === 'string' && delta.length > 0) {
        return [{ type: 'text', content: delta, raw: event }];
      }
      return [];
    }

    if (stepType === 'tool') {
      const info = step.tool_info as Record<string, unknown> | undefined;
      const toolName =
        (info?.name as string | undefined) ??
        (step.tool_name as string | undefined) ??
        'tool';
      if (state === 'ACTIVE') {
        return [{ type: 'tool_start', toolName, toolInput: info?.parameters, raw: event }];
      }
      // DONE or ERROR: emit the result. A soft-denied tool arrives as
      // state:"ERROR" with tool_info.error (probe P5) while the run itself
      // still ends SUCCESS, so this stays a tool_result, not a run error.
      const payload = state === 'ERROR'
        ? (info?.error ?? { message: 'agy tool step ended in ERROR state' })
        : info?.output;
      return [{ type: 'tool_result', toolName, toolResult: payload, raw: event }];
    }

    // user_input, checkpoint, unknown (undocumented but observed): structural.
    return [];
  }

  if (kind === 'result') {
    const result = e.result as Record<string, unknown> | undefined;
    if (!result) return [];
    const sessionId = result.conversation_id as string | undefined;

    if (result.status === 'SUCCESS') {
      const usage = result.usage as Record<string, unknown> | undefined;
      return [{
        type: 'done',
        sessionId,
        usage: usage
          ? {
              inputTokens: (usage.input_tokens as number) ?? 0,
              outputTokens: (usage.output_tokens as number) ?? 0,
              cachedTokens: (usage.cache_read_tokens as number) ?? undefined,
            }
          : zeroUsage(),
        raw: event,
      }];
    }

    // Any non-SUCCESS status: loud error, then the terminal done. Exit codes
    // are unreliable (auth failure exits 0), so status is the only signal.
    const status = (result.status as string) ?? 'UNKNOWN';
    const content =
      (result.error as string | undefined) ?? `agy run ended with status ${status}`;
    return [
      { type: 'error', content, raw: event },
      { type: 'done', sessionId, usage: zeroUsage(), raw: event },
    ];
  }

  return [];
}

/**
 * Stream normalized messages from an agy headless process. Guarantees exactly
 * one terminal done on every completed parser path:
 *   - SUCCESS result supplies the only done (its usage).
 *   - Non-SUCCESS result supplies error + done (from normalizeAgyEvent).
 *   - Missing terminal result supplies error + zero-usage done; the error
 *     content prefers stderr, then a non-zero exit code, then a generic note.
 *   - Parser exceptions surface as error + done.
 * stderr on a SUCCESS run does not fail the run; SUCCESS is authoritative.
 */
export async function* parseAgyStream(
  stdout: ReadableStream<Uint8Array>,
  stderr: ReadableStream<Uint8Array>,
  exited: Promise<number>
): AsyncIterable<Message> {
  let sessionId: string | undefined;
  let hadEvents = false;
  let terminalSeen = false;

  // Drain stderr concurrently so the pipe never fills.
  const stderrPromise = (async (): Promise<string> => {
    try {
      const reader = stderr.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text;
    } catch {
      return '';
    }
  })();

  try {
    for await (const event of parseNdjsonStream(stdout)) {
      hadEvents = true;
      if (terminalSeen) continue; // done stays terminal; ignore stragglers
      for (const msg of normalizeAgyEvent(event)) {
        if (msg.type === 'init' && msg.sessionId) sessionId = msg.sessionId;
        if (msg.type === 'done') terminalSeen = true;
        yield msg;
      }
    }
  } catch (error) {
    if (!terminalSeen) {
      terminalSeen = true;
      yield {
        type: 'error',
        content: `agy stream parse failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      yield { type: 'done', sessionId, usage: zeroUsage() };
    }
    return;
  }

  if (!terminalSeen) {
    const stderrText = await stderrPromise;
    const exitCode = await exited.catch(() => -1);
    let content: string;
    if (stderrText.trim()) {
      content = stderrText.trim();
    } else if (exitCode !== 0) {
      content = `agy exited with code ${exitCode} without a terminal result${hadEvents ? '' : ' (no events emitted)'}`;
    } else {
      content = 'agy produced no terminal result';
    }
    yield { type: 'error', content };
    yield { type: 'done', sessionId, usage: zeroUsage() };
  }
}

export class AgyBackend implements Backend {
  readonly name = 'agy';
  readonly command = 'agy';
  readonly systemPromptFile = undefined;

  async *run(options: RunOptions): AsyncIterable<Message> {
    const { prompt, context, config, cwd } = options;

    if (!prompt || !prompt.trim()) {
      yield { type: 'error', content: 'Empty prompt — agy requires a non-empty -p argument.', raw: null };
      yield { type: 'done', sessionId: undefined, usage: zeroUsage() };
      return;
    }

    const input = buildAgyInput(prompt, context, config.systemPrompt);
    const args = buildAgyRunArgs(input, config);

    try {
      const { stdout, stderr, process } = await spawnCliWithRetry({
        command: this.command,
        args,
        cwd,
      });
      yield* parseAgyStream(stdout, stderr, process.exited);
      await process.exited;
    } catch (error) {
      // Spawn-level failure (e.g., agy vanished between isAvailable and spawn).
      yield {
        type: 'error',
        content: error instanceof Error ? error.message : String(error),
      };
      yield { type: 'done', sessionId: undefined, usage: zeroUsage() };
    }
  }

  async *resume(options: ResumeOptions): AsyncIterable<Message> {
    const { sessionId, prompt, config, cwd } = options;

    const args = buildAgyResumeArgs(sessionId, prompt, config);

    try {
      const { stdout, stderr, process } = await spawnCliWithRetry({
        command: this.command,
        args,
        cwd,
      });
      yield* parseAgyStream(stdout, stderr, process.exited);
      await process.exited;
    } catch (error) {
      yield {
        type: 'error',
        content: error instanceof Error ? error.message : String(error),
      };
      yield { type: 'done', sessionId, usage: zeroUsage() };
    }
  }

  async isAvailable(): Promise<boolean> {
    return commandExists(this.command);
  }
}

export function createAgyBackend(): AgyBackend {
  return new AgyBackend();
}
