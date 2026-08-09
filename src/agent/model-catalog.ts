/**
 * Model catalog — the domain module behind `veda models`.
 *
 * Collects, per backend, the effective default (with its resolution source),
 * the aliases that route to it, and a bounded catalog of discoverable models.
 * Default execution is fully offline: local files and static data only. Live
 * refresh (--refresh) probes only Codex and Antigravity, writes nothing, and
 * falls back to offline data on failure.
 *
 * Overwhelm control: pi and droid collapse variant lineage into deterministic
 * provider-local "family heads"; scoped views (veda models <backend>) expand
 * the full lossless inventory. Grouping is display-only — it never rewrites
 * the model string passed to a backend.
 *
 * All parsers are defensive: they whitelist fields, skip malformed records,
 * and degrade to a labeled unavailable/partial section instead of throwing.
 * External files (~/.codex/models_cache.json, ~/.pi/agent/models.json,
 * ~/.factory/settings.json) are private foreign schemas — never trusted.
 */

import { existsSync } from 'fs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getHomeDir } from '../util/paths';
import { resolveModelWithSource, type GlobalConfig, type EffectiveModelResolution } from './config';
import { MODEL_ALIASES, normalizeModelName, type UserAliases } from './model-aliases';
import { detectBackends } from './detect';
import type { ModelsConfig } from '../cli/types';

// =============================================================================
// DTOs
// =============================================================================

export type CatalogSource =
  | 'live'
  | 'codex-cache'
  | 'pi-config'
  | 'droid-settings'
  | 'curated'
  | 'mixed'
  | 'unavailable';

export type Completeness = 'complete' | 'partial' | 'curated' | 'unavailable';

export interface CatalogModel {
  /** Canonical id exactly as passed to the backend (e.g. pi/neuralwatt/kimi-k3). */
  id: string;
  displayName?: string;
  /** Provenance tag for this row (curated, codex-cache, pi-config, droid-settings, live). */
  source: CatalogSource;
  /** Provenance markers: this row is configured (pi) or custom (droid). */
  configured?: boolean;
  custom?: boolean;
  /** Number of variant rows collapsed under this head (set by groupIntoFamilies). */
  variantCount?: number;
  /** droid: a fast-tier variant exists. */
  fast?: boolean;
}

export interface ModelAliasView {
  name: string;
  /** Canonical model target the backend receives. */
  model: string;
  reasoning?: string;
  /** 'user' when the alias came from MODEL_ALIASES config, else 'built-in'. */
  origin: 'user' | 'built-in';
}

export interface BackendModelCatalog {
  backend: string;
  installed: boolean;
  defaultModel: EffectiveModelResolution;
  aliases: ModelAliasView[];
  /** Visible (possibly capped, head-collapsed) rows for the current view. */
  models: CatalogModel[];
  catalogSource: CatalogSource;
  completeness: Completeness;
  totalCatalogModels: number;
  omittedCatalogModels: number;
  warnings: string[];
}

export interface ModelsResult {
  schemaVersion: 1;
  refreshed: boolean;
  backends: BackendModelCatalog[];
  warnings: string[];
}

// =============================================================================
// Dependencies (injectable for tests)
// =============================================================================

export interface ModelCatalogDependencies {
  /** Whether a backend CLI is installed. Default: real PATH probe. */
  isInstalled?: (backend: string) => boolean;
  /** Read a file as UTF-8, or undefined when missing/unreadable. Default: fs. */
  readFile?: (path: string) => string | undefined;
  /** Live Codex catalog probe (`codex debug models`). Default: real subprocess. */
  probeCodex?: () => Promise<string | undefined>;
  /** Live Antigravity probe (`agy models`). Default: real subprocess. */
  probeAgy?: () => Promise<string | undefined>;
  homeDir?: string;
}

const ALL_BACKENDS = ['codex', 'claude-code', 'droid', 'pi', 'agy'] as const;

const DISPLAY_CAP = 5;

// =============================================================================
// Curated static catalogs (labeled curated; drift with releases by design)
// =============================================================================

/** Claude family aliases (claude-code v2.1.226 help names fable/opus/sonnet/haiku). */
const CLAUDE_CURATED: Array<{ id: string; displayName?: string }> = [
  { id: 'claude-fable-5', displayName: 'Fable 5' },
  { id: 'claude-opus-4-6', displayName: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
];

/** Antigravity slugs observed 2026-08-09 via `agy models` (effort baked into slug). */
const AGY_CURATED: Array<{ id: string; displayName?: string }> = [
  { id: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)' },
  { id: 'gemini-3.6-flash-medium', displayName: 'Gemini 3.6 Flash (Medium)' },
  { id: 'gemini-3.6-flash-low', displayName: 'Gemini 3.6 Flash (Low)' },
  { id: 'gemini-3.5-flash-high', displayName: 'Gemini 3.5 Flash (High)' },
  { id: 'gemini-3.5-flash-medium', displayName: 'Gemini 3.5 Flash (Medium)' },
  { id: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Low)' },
  { id: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)' },
  { id: 'gemini-3.1-pro-low', displayName: 'Gemini 3.1 Pro (Low)' },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' },
];

/**
 * Droid built-in family heads (droid 0.175.0 error-envelope enumeration).
 * `variants` counts older lineage collapsed under the head; `fast` marks a
 * fast-tier variant. Display metadata only — scoped view expands exact ids.
 */
const DROID_BUILTIN_HEADS: Array<{ id: string; variants: number; fast?: boolean }> = [
  { id: 'claude-opus-4-8', variants: 5, fast: true },
  { id: 'claude-sonnet-5', variants: 2, fast: true },
  { id: 'claude-haiku-4-5-20251001', variants: 0 },
  { id: 'gpt-5.6-sol', variants: 8, fast: true },
  { id: 'glm-5.2', variants: 2, fast: true },
  { id: 'kimi-k2.7-code', variants: 1 },
  { id: 'deepseek-v4-pro', variants: 0 },
  { id: 'minimax-m3', variants: 2 },
  { id: 'grok-4.5', variants: 0 },
  { id: 'gemini-3.1-pro-preview', variants: 2 },
];

/** Full droid built-in inventory for the scoped view (droid 0.175.0). */
const DROID_BUILTIN_ALL: string[] = [
  'auto', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-8-fast', 'claude-opus-4-7',
  'claude-opus-4-7-fast', 'claude-opus-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-5',
  'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.5-fast', 'gpt-5.5-pro',
  'gpt-5.4', 'gpt-5.4-fast', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-fast', 'gpt-5.2',
  'gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'glm-5.2',
  'glm-5.2-fast', 'glm-5.1', 'kimi-k2.7-code', 'kimi-k2.6', 'nemotron-3-ultra',
  'deepseek-v4-pro', 'minimax-m3', 'minimax-m2.7', 'minimax-m2.5', 'grok-4.5',
];

// =============================================================================
// Family grouping (display-only, deterministic, table-driven)
// =============================================================================

/**
 * Trailing variant suffixes, longest-first so `short-fast` strips before
 * `short`/`fast`. Order matters; a single regex pass over a fixed list keeps
 * grouping deterministic and fixture-testable.
 */
const VARIANT_SUFFIXES = ['short-fast', 'highspeed', 'canary', 'nvfp4', 'fast', 'long', 'short', 'fp8'] as const;

/**
 * Map an exact model id to its family head key. Strips an org/hf prefix and at
 * most one trailing variant suffix, lowercases for case-insensitive dedup.
 * Pure: the same id always maps to the same head, and unknown shapes fall out
 * as their own singleton (lowercased base) so nothing is ever hidden.
 */
export function familyKey(id: string): string {
  let base = id;
  const hf = base.indexOf('hf:');
  if (hf !== -1) base = base.slice(hf + 3);
  const slash = base.lastIndexOf('/');
  if (slash !== -1) base = base.slice(slash + 1);
  const lower = base.toLowerCase();
  for (const suf of VARIANT_SUFFIXES) {
    const suffix = `-${suf}`;
    if (lower.endsWith(suffix) && lower.length > suffix.length) {
      return lower.slice(0, -suffix.length);
    }
  }
  return lower;
}

/**
 * Collapse canonical rows into family heads. Returns one fresh head row per
 * family in first-seen (provider) order, with `variantCount` = collapsed
 * members − 1. Pure: input rows are not mutated, and unknown shapes fall out
 * as singleton heads so nothing is ever hidden.
 */
export function groupIntoFamilies(rows: CatalogModel[]): CatalogModel[] {
  const headByKey = new Map<string, CatalogModel>();
  const countByKey = new Map<string, number>();
  const order: string[] = [];
  for (const row of rows) {
    const key = familyKey(row.id);
    countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
    if (!headByKey.has(key)) {
      headByKey.set(key, { ...row });
      order.push(key);
    }
  }
  return order.map(key => {
    const head = { ...headByKey.get(key)! };
    head.variantCount = (countByKey.get(key) ?? 1) - 1;
    return head;
  });
}

// =============================================================================
// Parsers (defensive; whitelist fields; never throw)
// =============================================================================

/** Parse Codex `debug models` / models_cache.json: visible only, priority-asc. */
export function parseCodexCatalog(value: unknown): CatalogModel[] {
  const models = (value as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  const rows: Array<{ row: CatalogModel; priority: number; index: number }> = [];
  models.forEach((m, index) => {
    const rec = m as Record<string, unknown>;
    const slug = rec?.slug;
    if (typeof slug !== 'string' || slug.length === 0) return;
    if (rec.visibility !== 'list') return;
    const priority = typeof rec.priority === 'number' ? rec.priority : Number.MAX_SAFE_INTEGER;
    const displayName = typeof rec.display_name === 'string' ? rec.display_name : undefined;
    rows.push({ row: { id: slug, displayName, source: 'codex-cache' }, priority, index });
  });
  rows.sort((a, b) => a.priority - b.priority || a.index - b.index);
  return rows.map(r => r.row);
}

/** Parse `agy models` tab-separated output: `slug<TAB>Display Name` per line. */
export function parseAgyModels(stdout: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^fetching/i.test(trimmed)) continue; // "Fetching available models..."
    const tab = trimmed.indexOf('\t');
    const slug = (tab === -1 ? trimmed : trimmed.slice(0, tab)).trim();
    if (!slug) continue;
    const displayName = tab === -1 ? undefined : trimmed.slice(tab + 1).trim() || undefined;
    out.push({ id: slug, displayName, source: 'live' });
  }
  return out;
}

/**
 * Extract custom models from ~/.factory/settings.json. Whitelists ONLY `id`
 * and `displayName`; baseUrl/apiKey/provider never cross the boundary.
 * Normalizes a missing `custom:` prefix. Skips entries without a usable id.
 */
export function parseDroidCustomModels(value: unknown): CatalogModel[] {
  const list = (value as { customModels?: unknown })?.customModels;
  if (!Array.isArray(list)) return [];
  const out: CatalogModel[] = [];
  for (const entry of list) {
    const rec = entry as Record<string, unknown>;
    const rawId = rec?.id;
    if (typeof rawId !== 'string' || rawId.length === 0) continue;
    const id = rawId.startsWith('custom:') ? rawId : `custom:${rawId}`;
    const displayName = typeof rec.displayName === 'string' ? rec.displayName : undefined;
    out.push({ id, displayName, source: 'droid-settings', custom: true });
  }
  return out;
}

/**
 * Parse pi's ~/.pi/agent/models.json into canonical pi/<provider>/<id> rows.
 * Marks each row configured (it came from the user's own pi config).
 */
export function parsePiCatalog(value: unknown): CatalogModel[] {
  const providers = (value as { providers?: unknown })?.providers;
  if (!providers || typeof providers !== 'object') return [];
  const out: CatalogModel[] = [];
  for (const [provider, cfg] of Object.entries(providers as Record<string, unknown>)) {
    const models = (cfg as { models?: unknown })?.models;
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      const id = (m as { id?: unknown })?.id;
      if (typeof id !== 'string' || id.length === 0) continue;
      const name = (m as { name?: unknown })?.name;
      out.push({
        id: `pi/${provider}/${id}`,
        displayName: typeof name === 'string' ? name : undefined,
        source: 'pi-config',
        configured: true,
      });
    }
  }
  return out;
}

// =============================================================================
// Alias collection
// =============================================================================

/** Aliases routing to `backend`, user config overriding built-ins by name. */
export function collectAliases(backend: string, userAliases?: UserAliases): ModelAliasView[] {
  const merged = new Map<string, ModelAliasView>();
  for (const [name, target] of Object.entries(MODEL_ALIASES)) {
    if (target.backend === backend) {
      merged.set(name, { name, model: target.model, reasoning: target.reasoning, origin: 'built-in' });
    }
  }
  for (const [name, target] of Object.entries(userAliases ?? {})) {
    if (target.backend === backend) {
      merged.set(normalizeModelName(name), { name: normalizeModelName(name), model: target.model, reasoning: target.reasoning, origin: 'user' });
    }
  }
  return [...merged.values()];
}

// =============================================================================
// Default file readers / probes
// =============================================================================

function defaultReadFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

async function defaultProbe(command: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => { try { proc?.kill(); } catch { /* noop */ } }, timeoutMs);
    const stdout = proc.stdout;
    if (typeof stdout === 'number') { clearTimeout(timer); return undefined; }
    const text = await new Response(stdout).text();
    await proc.exited;
    clearTimeout(timer);
    return text;
  } catch {
    return undefined;
  }
}

const REFRESH_TIMEOUT_MS = 10_000;

// =============================================================================
// Collection orchestration
// =============================================================================

interface CollectContext {
  globalConfig?: GlobalConfig;
  deps: ModelCatalogDependencies;
  refresh: boolean;
  warnings: string[];
}

function resolveDeps(deps: ModelCatalogDependencies) {
  return {
    isInstalled: deps.isInstalled ?? defaultIsInstalled,
    readFile: deps.readFile ?? defaultReadFile,
    home: deps.homeDir ?? getHomeDir(),
    probeCodex: deps.probeCodex ?? (() => defaultProbe('codex', ['debug', 'models'], REFRESH_TIMEOUT_MS)),
    probeAgy: deps.probeAgy ?? (() => defaultProbe('agy', ['models'], REFRESH_TIMEOUT_MS)),
  };
}

let cachedDetect: Set<string> | undefined;
function defaultIsInstalled(backend: string): boolean {
  if (!cachedDetect) {
    cachedDetect = new Set(detectBackends().map(b => b.name));
  }
  return cachedDetect.has(backend);
}

/** Dedupe rows by canonical id (first/higher-priority source wins). */
function dedupe(rows: CatalogModel[]): CatalogModel[] {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

/** Extract the provider from a canonical pi/<provider>/<id>; '' otherwise. */
function piProvider(id: string): string {
  if (!id.startsWith('pi/')) return '';
  const rest = id.slice(3);
  const slash = rest.indexOf('/');
  return slash === -1 ? '' : rest.slice(0, slash);
}

/**
 * Collapse pi rows into family heads grouped provider-locally (navigator
 * invariant: never merge across providers — same id on two providers is two
 * selectable units). Preserves provider order, then each provider's own order.
 */
function groupPiProviderLocal(rows: CatalogModel[]): CatalogModel[] {
  const byProvider = new Map<string, CatalogModel[]>();
  const providerOrder: string[] = [];
  for (const row of rows) {
    const prov = piProvider(row.id);
    if (!byProvider.has(prov)) { byProvider.set(prov, []); providerOrder.push(prov); }
    byProvider.get(prov)!.push(row);
  }
  const out: CatalogModel[] = [];
  for (const prov of providerOrder) {
    out.push(...groupIntoFamilies(byProvider.get(prov)!));
  }
  return out;
}

/**
 * Apply the display policy for a backend: collapse families (pi grouped
 * provider-locally; droid rows arrive pre-collapsed as curated heads), inject
 * alias targets so they stay visible, then cap heads unless scoped.
 */
function applyDisplayPolicy(
  backend: string,
  rows: CatalogModel[],
  aliases: ModelAliasView[],
  scoped: boolean
): { visible: CatalogModel[]; total: number; omitted: number } {
  // pi: collapse variant lineage into provider-local family heads.
  // droid: rows are already customs + curated heads (no regroup, keep order).
  const processed = backend === 'pi' ? groupPiProviderLocal(rows) : rows.slice();
  const total = processed.length;

  // Alias targets must stay visible even when capped out.
  const aliasTargets = new Set(aliases.map(a => a.model));
  const injected: CatalogModel[] = [];
  const rest: CatalogModel[] = [];
  for (const row of processed) {
    if (aliasTargets.has(row.id)) injected.push(row);
    else rest.push(row);
  }
  const ordered = [...injected, ...rest];

  if (scoped) {
    return { visible: ordered, total, omitted: 0 };
  }
  const visible = ordered.slice(0, DISPLAY_CAP);
  return { visible, total, omitted: Math.max(0, total - visible.length) };
}

async function collectBackend(backend: string, scoped: boolean, ctx: CollectContext): Promise<BackendModelCatalog> {
  const deps = resolveDeps(ctx.deps);
  const warnings: string[] = [];
  const installed = deps.isInstalled(backend);
  const defaultModel = resolveModelWithSource({ backend, globalConfig: ctx.globalConfig });
  const aliases = collectAliases(backend, ctx.globalConfig?.modelAliases);

  let rows: CatalogModel[] = [];
  let catalogSource: CatalogSource = 'unavailable';
  let completeness: Completeness = 'unavailable';

  switch (backend) {
    case 'codex': {
      let liveRows: CatalogModel[] | undefined;
      if (ctx.refresh) {
        const out = await deps.probeCodex();
        if (out !== undefined) {
          try {
            liveRows = parseCodexCatalog(JSON.parse(out));
          } catch {
            warnings.push('codex --refresh: could not parse live catalog; using cache');
          }
        } else {
          warnings.push('codex --refresh: probe failed; using cache');
        }
      }
      if (liveRows && liveRows.length > 0) {
        rows = liveRows.map(r => ({ ...r, source: 'live' as CatalogSource }));
        catalogSource = 'live';
        completeness = 'partial';
      } else {
        const text = deps.readFile(join(deps.home, '.codex', 'models_cache.json'));
        if (text !== undefined) {
          try {
            rows = parseCodexCatalog(JSON.parse(text));
            catalogSource = rows.length > 0 ? 'codex-cache' : 'unavailable';
            completeness = rows.length > 0 ? 'partial' : 'unavailable';
          } catch {
            warnings.push('codex: models_cache.json malformed; run with --refresh');
          }
        } else if (!ctx.refresh) {
          warnings.push('codex: no local cache; run with --refresh to fetch the live catalog');
        }
      }
      break;
    }

    case 'claude-code': {
      rows = CLAUDE_CURATED.map(c => ({ id: c.id, displayName: c.displayName, source: 'curated' as CatalogSource }));
      catalogSource = 'curated';
      completeness = 'curated';
      if (ctx.refresh) warnings.push('claude-code: no live model discovery; showing curated list');
      break;
    }

    case 'droid': {
      const text = deps.readFile(join(deps.home, '.factory', 'settings.json'));
      let customs: CatalogModel[] = [];
      if (text !== undefined) {
        try {
          customs = parseDroidCustomModels(JSON.parse(text));
        } catch {
          warnings.push('droid: settings.json malformed; custom models unavailable');
        }
      }
      if (scoped) {
        const builtins = DROID_BUILTIN_ALL.map(id => ({ id, source: 'curated' as CatalogSource }));
        rows = dedupe([...customs, ...builtins]);
      } else {
        const heads = DROID_BUILTIN_HEADS.map(h => ({
          id: h.id,
          displayName: undefined,
          source: 'curated' as CatalogSource,
          variantCount: h.variants,
          fast: h.fast,
        } as CatalogModel));
        rows = dedupe([...customs, ...heads]);
      }
      catalogSource = customs.length > 0 ? 'mixed' : 'curated';
      completeness = 'partial';
      if (ctx.refresh) warnings.push('droid: built-in discovery is curated; re-read custom models from settings');
      break;
    }

    case 'pi': {
      const text = deps.readFile(join(deps.home, '.pi', 'agent', 'models.json'));
      if (text !== undefined) {
        try {
          rows = parsePiCatalog(JSON.parse(text));
          catalogSource = rows.length > 0 ? 'pi-config' : 'unavailable';
          completeness = rows.length > 0 ? 'partial' : 'unavailable';
        } catch {
          warnings.push('pi: models.json malformed; catalog unavailable');
        }
      }
      break;
    }

    case 'agy': {
      if (ctx.refresh) {
        const out = await deps.probeAgy();
        const live = out !== undefined ? parseAgyModels(out) : [];
        if (live.length > 0) {
          rows = live;
          catalogSource = 'live';
          completeness = 'complete';
          break;
        }
        warnings.push('agy --refresh: probe failed; using curated list');
      }
      rows = AGY_CURATED.map(c => ({ id: c.id, displayName: c.displayName, source: 'curated' as CatalogSource }));
      catalogSource = 'curated';
      completeness = 'curated';
      break;
    }
  }

  const { visible, total, omitted } = applyDisplayPolicy(backend, rows, aliases, scoped);

  return {
    backend,
    installed,
    defaultModel,
    aliases: scoped ? aliases : aliases.slice(0, DISPLAY_CAP),
    models: visible,
    catalogSource,
    completeness,
    totalCatalogModels: total,
    omittedCatalogModels: omitted,
    warnings,
  };
}

/**
 * Collect the full models result. Default path is offline; refresh probes run
 * concurrently for the applicable backends and fall back soft.
 */
export async function collectModels(
  config: ModelsConfig,
  globalConfig: GlobalConfig | undefined,
  deps: ModelCatalogDependencies = {}
): Promise<ModelsResult> {
  const warnings: string[] = [];
  const scoped = config.backend !== undefined;
  const backends = scoped ? [config.backend!] : [...ALL_BACKENDS];

  if (!scoped && config.refresh) {
    warnings.push('live refresh applies to codex and agy; claude-code and droid have no live probe');
  }

  const results: BackendModelCatalog[] = [];
  for (const b of backends) {
    results.push(await collectBackend(b, scoped, { globalConfig, deps, refresh: config.refresh, warnings }));
  }

  return {
    schemaVersion: 1,
    refreshed: config.refresh,
    backends: results,
    warnings,
  };
}
