/**
 * GPT catalog. Separate settings key from Claude model_policy.
 * Live ids from ChatGPT sync; seed is empty-catalog fallback.
 */
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { isGptSeriesId, isSyncableGptCatalogId } from './gpt-ids.mjs'
import { parseNativeCodexModelInfo } from './codex-models.mjs'

const SETTINGS_KEY = 'gpt_model_policy'

const CAP_GPT = {
  context_window: 272000,
  supports_1m: false,
  thinking_mode: 'enabled_only',
  supports_adaptive: false,
  requires_adaptive: false,
  supports_interleaved: false,
  supports_effort: false,
  supports_context_management: false,
}

function entry(id, extra = {}) {
  return {
    id,
    display_name: extra.display_name || extra.label || id,
    family: 'codex',
    enabled: extra.enabled !== false,
    sort: extra.sort || 80,
    capabilities: extra.capabilities || { ...CAP_GPT },
    params: extra.params || { max_tokens_default: 16384, max_tokens_cap: 128000 },
    aliases: extra.aliases || [],
    ...(extra.codex_model_info ? { codex_model_info: extra.codex_model_info } : {}),
  }
}

export function seedGptPolicy() {
  const models = {}
  for (const [id, extra] of [
    ['gpt-6-sol', { display_name: 'GPT-6 Sol', sort: 70 }],
    ['gpt-6-luna', { display_name: 'GPT-6 Luna', sort: 71 }],
    ['gpt-5.6', { display_name: 'GPT-5.6', sort: 76 }],
    ['gpt-5.5', { display_name: 'GPT-5.5', sort: 77 }],
    ['gpt-5.4', { display_name: 'GPT-5.4', sort: 80, aliases: ['codex'] }],
    ['gpt-5.4-mini', { display_name: 'GPT-5.4 Mini', sort: 81 }],
    ['gpt-5.3-codex', { display_name: 'GPT-5.3 Codex', sort: 82 }],
  ]) {
    models[id] = entry(id, extra)
  }
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    source: 'seed',
    platform: 'openai',
    models,
  }
}

let policy = seedGptPolicy()
let loaded = false

function persist() {
  try {
    new SettingsRepo().set(SETTINGS_KEY, policy)
  } catch (e) {
    console.warn('[gpt-model-policy] persist failed', e?.message || e)
  }
}

export function loadGptModelPolicy({ force = false } = {}) {
  if (loaded && !force) return policy
  try {
    const stored = new SettingsRepo().get(SETTINGS_KEY, null)
    if (stored && typeof stored === 'object' && stored.models && typeof stored.models === 'object') {
      const live = stored.source === 'codex' && Object.keys(stored.models).length
      policy = {
        ...(live ? stored : { ...seedGptPolicy(), ...stored, models: { ...seedGptPolicy().models, ...stored.models } }),
        platform: 'openai',
      }
      policy.source = policy.source || 'settings'
    } else {
      policy = seedGptPolicy()
      persist()
    }
  } catch {
    policy = seedGptPolicy()
  }
  loaded = true
  return policy
}

export function getGptModelPolicy() {
  if (!loaded) loadGptModelPolicy()
  return policy
}

export function saveGptModelPolicy(next) {
  const seed = seedGptPolicy()
  const models = { ...(seed.models || {}) }
  if (next?.models && typeof next.models === 'object') {
    for (const [id, row] of Object.entries(next.models)) {
      if (!isGptSeriesId(id) || !row || typeof row !== 'object') continue
      models[id] = { ...models[id], ...row, id, family: 'codex' }
    }
  }
  policy = {
    ...seed,
    ...next,
    models,
    platform: 'openai',
    updated_at: new Date().toISOString(),
    source: 'panel',
  }
  persist()
  return policy
}
export function listGptPolicyModels() {
  if (!loaded) loadGptModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGptSeriesId(id) && cfg?.enabled !== false)
    .map(([id, cfg]) => ({ id, ...cfg, family: 'codex' }))
    .sort((a, b) => (a.sort || 80) - (b.sort || 80) || String(a.id).localeCompare(String(b.id)))
}

export function getGptPolicyCatalogIds({ enabledOnly = false } = {}) {
  if (!loaded) loadGptModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGptSeriesId(id) && (!enabledOnly || cfg?.enabled !== false))
    .map(([id]) => id)
}

export function isGptModelEnabled(id) {
  if (!isGptSeriesId(id)) return false
  if (!loaded) loadGptModelPolicy()
  const row = policy.models?.[id]
  if (row) return row.enabled !== false
  if (policy.source === 'codex' && Object.keys(policy.models || {}).length) return false
  return true
}

export function resetGptModelPolicy() {
  policy = seedGptPolicy()
  loaded = true
  persist()
  return policy
}

export function syncGptIdsIntoPolicy(ids = []) {
  if (!loaded) loadGptModelPolicy()
  const live = []
  const seen = new Set()
  for (const item of ids || []) {
    const id = String(typeof item === 'string' ? item : item?.id || '').trim()
    if (!isSyncableGptCatalogId(id) || seen.has(id.toLowerCase())) continue
    seen.add(id.toLowerCase())
    live.push({
      id,
      display_name: String((typeof item === 'object' && item?.display_name) || '').trim(),
      ...(typeof item === 'object' && item?.codex_model_info ? { codex_model_info: item.codex_model_info } : {}),
    })
  }
  if (!live.length) {
    return { ok: true, synced: 0, ids: listGptPolicyModels().map((m) => m.id) }
  }
  const next = {}
  for (const row of live) {
    const prev = policy.models[row.id]
    next[row.id] = entry(row.id, {
      ...prev,
      display_name: row.display_name || prev?.display_name || row.id,
      codex_model_info: row.codex_model_info || prev?.codex_model_info,
      enabled: prev?.enabled !== false,
      source: 'codex',
    })
  }
  policy = {
    ...policy,
    models: next,
    platform: 'openai',
    updated_at: new Date().toISOString(),
    source: 'codex',
  }
  persist()
  return {
    ok: true,
    synced: live.length,
    ids: listGptPolicyModels().map((m) => m.id),
  }
}

/** Return only complete upstream Codex ModelInfo rows for native clients. */
export function listNativeCodexModelCatalog() {
  if (!loaded) loadGptModelPolicy()
  return Object.entries(policy.models || {})
    .filter(([id, cfg]) => isGptSeriesId(id) && cfg?.enabled !== false && cfg?.codex_model_info)
    .map(([id, cfg]) => parseNativeCodexModelInfo(cfg.codex_model_info, id, cfg.codex_model_info.display_name))
    .filter(Boolean)
}
