/** GPT catalog ids and Codex request ids. No I/O. */

export const SKIP_GPT =
  /^(whisper|tts-|dall-e|chatgpt-image|gpt-image|text-embedding|text-moderation|omni-moderation|davinci|babbage|curie)/i

export const GPT_ID_PREFIX = /^gpt/i

export function isGptSeriesId(id) {
  const s = String(id || '').trim()
  return GPT_ID_PREFIX.test(s) && !SKIP_GPT.test(s)
}

// Supporting models serve Codex requests without joining the GPT model catalog.
const CODEX_SUPPORTING_MODEL_IDS = Object.freeze(['codex-auto-review'])

export function isCodexSupportingModelId(id) {
  return CODEX_SUPPORTING_MODEL_IDS.includes(String(id || '').trim())
}

export function isCodexRequestModelId(id) {
  return isGptSeriesId(id) || isCodexSupportingModelId(id)
}

/** ChatGPT 网页目录里的 wm / luna-wm 变体，Codex 账号请求会 400。gpt-6-luna 是正式模型。 */
export function isSyncableGptCatalogId(id) {
  const slug = String(id || '').trim()
  if (!isGptSeriesId(slug)) return false
  if (/luna-wm/i.test(slug) || /(?:^|[-_])wm(?:[-_]|$)/i.test(slug)) return false
  return true
}
