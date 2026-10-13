/**
 * Inbound platform from model id. Unknown models fail closed.
 * Codex = GPT chat ids plus registered supporting models. Claude = claude-* family.
 */
import { SKIP_GPT, isCodexRequestModelId } from './gpt-ids.mjs'
export function detectInboundPlatform(model) {
  const raw = String(model || '').trim()
  if (!raw) {
    return {
      ok: false,
      code: 'model_required',
      message: 'model is required',
    }
  }
  const id = raw.split('/').filter(Boolean).pop() || raw
  const lower = id.toLowerCase()
  if (SKIP_GPT.test(lower)) {
    return {
      ok: false,
      code: 'model_not_supported',
      message: `model '${raw}' is not a GPT chat model`,
    }
  }
  if (isCodexRequestModelId(id)) return { ok: true, platform: 'openai', model: id }
  if (
    lower.startsWith('claude-') ||
    lower.startsWith('anthropic.claude-') ||
    /^(sonnet|opus|haiku|fable)(-|$)/i.test(lower)
  ) {
    return { ok: true, platform: 'anthropic', model: id }
  }
  return {
    ok: false,
    code: 'model_not_supported',
    message: `model '${raw}' is not recognized. No hop.`,
  }
}
