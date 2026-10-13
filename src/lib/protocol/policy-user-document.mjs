/**
 * Direct user text for the protocol policy gate, including prior user turns.
 * Tool results are data even when Anthropic puts them in a user message.
 * Refusal fingerprints and similarity keep their separate document semantics.
 */
const TEXT_TYPES = new Set(['text', 'input_text'])

function textBlock(part) {
  if (typeof part === 'string') return part
  if (!part || typeof part !== 'object') return ''
  if (part.type != null && !TEXT_TYPES.has(part.type)) return ''
  return typeof part.text === 'string' ? part.text : ''
}

function directContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return textBlock(content)
  return content.map(textBlock).filter(Boolean).join('\n')
}

function inputItemText(item) {
  if (typeof item === 'string') return item
  if (!item || typeof item !== 'object') return ''
  // Responses message items may omit their type; input text has an implicit user role.
  if (item.role != null && item.role !== 'user') return ''
  if (TEXT_TYPES.has(item.type)) return textBlock(item)
  if (item.type != null && item.type !== 'message') return ''
  return directContent(item.content ?? item)
}

function userTexts(body) {
  if (!body || typeof body !== 'object') return []
  const out = []
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message?.role !== 'user') continue
    const text = directContent(message.content)
    if (text) out.push(text)
  }
  if (typeof body.input === 'string') out.push(body.input)
  else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      const text = inputItemText(item)
      if (text) out.push(text)
    }
  }
  return out
}

/** Inbound and converted direct user text, with exact repeats dropped. */
export function policyUserDocument(inbound, body = inbound) {
  const seen = new Set()
  const parts = []
  for (const source of [inbound, body]) {
    for (const text of userTexts(source)) {
      // Keep case until prepareInterceptText decodes case-sensitive base64.
      const direct = text.trim()
      if (!direct || seen.has(direct)) continue
      seen.add(direct)
      parts.push(direct)
    }
  }
  return parts.join('\n')
}
