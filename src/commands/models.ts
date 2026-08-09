/**
 * `veda models` — offline-first model discovery per backend.
 *
 * Prints, per backend: the effective default (with its resolution source),
 * the aliases that route to it, and a bounded catalog of discoverable models.
 * Text and JSON render the same ModelsResult; JSON stays clean (warnings live
 * inside the document, never on stdout as prose).
 */

import type { ModelsConfig } from '../cli/types';
import { loadGlobalConfig } from '../agent/config';
import {
  collectModels,
  type ModelsResult,
  type BackendModelCatalog,
  type CatalogModel,
} from '../agent/model-catalog';

const SOURCE_LABEL: Record<string, string> = {
  'explicit': 'explicit',
  'backend-config': 'backend config',
  'global-config': 'global config MODEL',
  'built-in': 'built-in',
};

function modelLine(m: CatalogModel): string {
  const parts: string[] = [m.id];
  if (m.variantCount && m.variantCount > 0) parts.push(`(+${m.variantCount} variant${m.variantCount === 1 ? '' : 's'})`);
  if (m.fast) parts.push('(fast available)');
  if (m.displayName && m.displayName !== m.id) parts.push(`— ${m.displayName}`);
  return parts.join(' ');
}

function formatBackend(b: BackendModelCatalog): string {
  const lines: string[] = [];
  const installed = b.installed ? 'installed' : 'not installed';
  lines.push(`${b.backend}  (${installed})`);

  const def = b.defaultModel;
  const defSrc = SOURCE_LABEL[def.source] ?? def.source;
  lines.push(`  default  ${def.model ?? '(none)'}  (${defSrc})`);

  if (b.aliases.length > 0) {
    lines.push('  aliases');
    for (const a of b.aliases) {
      const r = a.reasoning ? ` [${a.reasoning}]` : '';
      const origin = a.origin === 'user' ? '  (your alias)' : '';
      lines.push(`    ${a.name} → ${a.model}${r}${origin}`);
    }
  }

  if (b.models.length > 0) {
    const sourceTag = b.catalogSource !== 'unavailable' ? ` (${b.catalogSource} · ${b.completeness})` : '';
    lines.push(`  models${sourceTag}`);
    for (const m of b.models) {
      lines.push(`    ${modelLine(m)}`);
    }
    if (b.omittedCatalogModels > 0) {
      lines.push(`    +${b.omittedCatalogModels} more  (veda models ${b.backend} for the full inventory)`);
    }
  } else if (b.catalogSource === 'unavailable') {
    lines.push('  models   (unavailable)');
  }

  for (const w of b.warnings) {
    lines.push(`  ! ${w}`);
  }
  return lines.join('\n');
}

export function formatModelsText(result: ModelsResult): string {
  const sections = result.backends.map(b => formatBackend(b));
  const globalWarnings = result.warnings.map(w => `! ${w}`);
  const body = [...sections, ...globalWarnings].filter(s => s.length > 0).join('\n\n');
  const header = result.refreshed ? 'models (refreshed — live data for codex/agy)' : 'models';
  return `${header}\n\n${body}`;
}

export async function handleModels(config: ModelsConfig): Promise<void> {
  const globalConfig = await loadGlobalConfig();
  const result = await collectModels(config, globalConfig);

  if (config.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(formatModelsText(result));
}
