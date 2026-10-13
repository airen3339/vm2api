import test from 'node:test'
import assert from 'node:assert/strict'
import {
  prepareCliHopBody,
  prepareOutboundAttempt,
  stripCliOwnedSystem,
} from '../../src/lib/protocol/outbound-attempt.mjs'
import { CRS_OFFICIAL_SYSTEM, CRS_OFFICIAL_CLI_SYSTEM } from '../../src/lib/identity/crs-persona.mjs'
import { CRS_OFFICIAL_AGENT_PROMPT } from '../../src/lib/identity/official-cc-system-2.1.241.mjs'
import { applyMessageBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'

test('prepareCliHopBody drops metadata and CLI-owned system but keeps official agent leftover', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    metadata: { user_id: '{"device_id":"abc"}' },
    system: [
      {
        type: 'text',
        text: "x-anthropic-billing-header: cc_version=2.8.4; prompt_version=You are a Claude agent, built on Anthropic's Claude Agent SDK.;",
      },
      { type: 'text', text: CRS_OFFICIAL_SYSTEM },
      { type: 'text', text: CRS_OFFICIAL_AGENT_PROMPT },
      { type: 'text', text: '# Environment\nTime zone: America/New_York' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(body.metadata, undefined)
  assert.equal(body.system.length, 1)
  assert.equal(body.system[0].text, CRS_OFFICIAL_AGENT_PROMPT)
  assert.equal(body.model, 'claude-sonnet-5')
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ])
  assert.equal(body.stream, true)
})

test('prepareCliHopBody keeps caller leftover system and tools', () => {
  const body = prepareCliHopBody({
    model: 'claude-opus-5',
    max_tokens: 1024,
    system: [
      { type: 'text', text: CRS_OFFICIAL_CLI_SYSTEM },
      { type: 'text', text: '你是一个高速收费员。' },
    ],
    tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }],
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: '你好呀。' }],
  })
  assert.equal(body.metadata, undefined)
  assert.equal(body.system.length, 1)
  assert.equal(body.system[0].text, '你是一个高速收费员。')
  assert.equal(body.tools[0].name, 'get_weather')
  assert.equal(body.thinking.type, 'disabled')
})

test('stripCliOwnedSystem leaves empty inbound system absent', () => {
  assert.equal(stripCliOwnedSystem(undefined), undefined)
  assert.equal(stripCliOwnedSystem(''), undefined)
  assert.equal(stripCliOwnedSystem([{ type: 'text', text: '' }]), undefined)
})

test('prepareCliHopBody fills 2.1.263 thinking effort and context_management', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'omitted' })
  assert.equal(body.output_config.effort, 'high')
  assert.equal(body.context_management.edits[0].type, 'clear_thinking_20251015')
  assert.equal(body.metadata, undefined)
  assert.equal(body.system, undefined)
})

test('prepareCliHopBody does not overwrite caller thinking disabled', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(body.thinking.type, 'disabled')
  assert.equal(body.context_management, undefined)
})

for (const model of ['claude-sonnet-5.5', 'claude-opus-5.5']) {
  for (const repaired of [false, true]) {
    test(`cli-hop preserves native updates for ${model}, repaired=${repaired}`, () => {
      const thinking = { type: 'adaptive', display: 'updates' }
      const body = prepareCliHopBody(
        {
          model,
          max_tokens: 128000,
          thinking,
          output_config: { effort: 'high' },
          messages: [{ role: 'user', content: 'hi' }],
        },
        { repaired },
      )
      assert.deepEqual(body.thinking, { type: 'adaptive', display: 'updates' })
      assert.equal(body.max_tokens, 128000)
      assert.equal(body.output_config.effort, 'high')
      assert.deepEqual(thinking, { type: 'adaptive', display: 'updates' }, 'preserve caller thinking')
    })
  }
}

for (const repaired of [false, true]) {
  test(`cli-hop preserves updates on manual enabled thinking, repaired=${repaired}`, () => {
    const body = prepareCliHopBody(
      {
        model: 'claude-sonnet-4-5',
        max_tokens: 4096,
        thinking: { type: 'enabled', budget_tokens: 2048, display: 'updates' },
        messages: [{ role: 'user', content: 'hi' }],
      },
      { repaired },
    )
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2048, display: 'updates' })
    assert.equal(body.max_tokens, 4096)
  })
}

test('cli-hop preserves updates after Opus 5.5 enabled-to-adaptive normalization', () => {
  const body = prepareCliHopBody({
    model: 'claude-opus-5.5',
    max_tokens: 128000,
    thinking: { type: 'enabled', budget_tokens: 8000, display: 'updates' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'updates' })
})

for (const display of ['summarized', 'omitted', 'future-display', 'UPDATES', ' updates ']) {
  test(`cli-hop preserves caller display ${JSON.stringify(display)}`, () => {
    const body = prepareCliHopBody({
      model: 'claude-sonnet-5.5',
      thinking: { type: 'adaptive', display },
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.deepEqual(body.thinking, { type: 'adaptive', display })
  })
}

test('cli-hop keeps Haiku thinking disabled when caller requests updates', () => {
  const body = prepareCliHopBody({
    model: 'claude-haiku-4-5',
    thinking: { type: 'adaptive', display: 'updates' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.deepEqual(body.thinking, { type: 'disabled' })
})

test('cli-hop does not translate updates on disabled thinking', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    thinking: { type: 'disabled', display: 'updates' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.deepEqual(body.thinking, { type: 'disabled', display: 'updates' })
})

test('HTTP outbound keeps updates for a provider supporting its beta', () => {
  const canonicalBody = {
    model: 'claude-sonnet-5.5',
    max_tokens: 4096,
    thinking: { type: 'adaptive', display: 'updates' },
    messages: [{ role: 'user', content: 'hi' }],
  }
  const body = prepareOutboundAttempt({
    canonicalBody,
    officialClient: true,
    identity: {
      vmId: 'vm-fixture',
      deviceId: 'd'.repeat(64),
      accountUuid: '11111111-1111-4111-8111-111111111111',
    },
  }).body
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'updates' })
})

test('prepareCliHopBody strips unsigned empty dummy and short thinking history', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'keep-me', signature: 'sig_real_1234567890abcdef' },
          { type: 'thinking', thinking: 'no-sig' },
          { type: 'thinking', thinking: '', signature: 'sig_empty_text_still_long_enough' },
          { type: 'thinking', thinking: 'dummy', signature: 'skip_thought_signature_validator' },
          { type: 'thinking', thinking: 'short', signature: 'abc' },
          { type: 'text', text: 'hello' },
        ],
      },
      { role: 'user', content: 'again' },
    ],
  })
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'omitted' })
  assert.equal(body.temperature, 1)
  assert.deepEqual(body.messages[1].content, [
    { type: 'thinking', thinking: 'keep-me', signature: 'sig_real_1234567890abcdef' },
    { type: 'text', text: 'hello' },
  ])
})

test('prepareCliHopBody drops an assistant turn that is only unsigned thinking', () => {
  const body = prepareCliHopBody({
    model: 'claude-opus-5.5',
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'draft only', signature: 'abc' }],
      },
      { role: 'user', content: 'continue' },
    ],
  })
  assert.equal(body.model, 'claude-opus-5-5')
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ['user'],
  )
  assert.deepEqual(body.messages.at(-1).content, [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'continue', cache_control: { type: 'ephemeral', ttl: '1h' } },
  ])
})

test('prepareCliHopBody repaired does not refill thinking after signature downgrade', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'plan' },
            { type: 'text', text: 'hello' },
          ],
        },
        { role: 'user', content: 'again' },
      ],
    },
    { repaired: true },
  )
  assert.equal(body.thinking, undefined)
  assert.equal(body.context_management, undefined)
  assert.deepEqual(body.messages[1].content, [
    { type: 'text', text: 'plan' },
    { type: 'text', text: 'hello' },
  ])
})

test('prepareCliHopBody disables thinking on Haiku so wrap CLI cannot inherit adaptive', () => {
  const body = prepareCliHopBody({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(body.thinking?.type, 'disabled')
  assert.equal(body.output_config, undefined)
  assert.equal(body.context_management, undefined)
})

test('prepareCliHopBody drops caller context_management on Haiku (thinking pinned off)', () => {
  // Claude Code 的 Haiku 旁路请求会带 clear_thinking。cli-hop 把 Haiku thinking 固定为 disabled
  // 且跳过 beta 清洗，所以必须在这里删掉该字段，否则上游会杀掉 CLI。
  const body = prepareCliHopBody({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(body.thinking?.type, 'disabled')
  assert.equal(body.context_management, undefined)
})

test('prepareCliHopBody disables Haiku adaptive thinking', () => {
  const body = prepareCliHopBody({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    thinking: { type: 'adaptive', display: 'omitted' },
    messages: [{ role: 'user', content: 'hello' }],
  })
  assert.equal(body.thinking.type, 'disabled')
})

function withoutMessageCache(body) {
  return {
    ...body,
    messages: (body.messages || []).map((message) => {
      if (!Array.isArray(message?.content)) return message
      return {
        ...message,
        content: message.content.map((block) => {
          if (!block || typeof block !== 'object' || !block.cache_control) return block
          const { cache_control: _drop, ...rest } = block
          return rest
        }),
      }
    }),
  }
}

function messageMarkers(body) {
  const hits = []
  for (const [index, message] of (body.messages || []).entries()) {
    if (!Array.isArray(message?.content)) continue
    for (const [blockIndex, block] of message.content.entries()) {
      if (!block?.cache_control) continue
      hits.push({ index, blockIndex, type: block.type, ttl: block.cache_control.ttl })
    }
  }
  return hits
}

function freezeTree(value) {
  if (!value || typeof value !== 'object') return value
  for (const child of Object.values(value)) freezeTree(child)
  return Object.freeze(value)
}

for (const cacheTtl of ['5m', '1h']) {
  for (const repaired of [false, true]) {
    test(`cli-hop caches merged Sonnet history before a changing tail, ttl=${cacheTtl}, repaired=${repaired}`, () => {
      let blocks = Array.from({ length: 105 }, (_, i) => ({ type: 'text', text: `History block ${i}.` }))
      let previous = null
      for (let turn = 0; turn < 3; turn++) {
        if (turn) {
          blocks = blocks.map((block, i) =>
            i < blocks.length - 2 ? block : { ...block, text: `${block.text} Updated ${turn}.` },
          )
          blocks.push({ type: 'text', text: `New tail ${turn}.` })
        }
        const incoming = freezeTree({
          model: 'claude-sonnet-5.5',
          max_tokens: 2112,
          messages: [
            { role: 'user', content: [{ ...blocks[0], cache_control: { type: 'ephemeral', scope: 'global' } }] },
            {
              role: 'user',
              content: blocks.slice(1).map((block) => ({ ...block, cache_control: { type: 'ephemeral', ttl: '5m' } })),
            },
          ],
        })
        const snapshot = structuredClone(incoming)
        const body = prepareCliHopBody(incoming, { cacheTtl, repaired })
        assert.deepEqual(incoming, snapshot, 'caller body is immutable')
        assert.deepEqual(
          body.messages.map((message) => message.role),
          ['user'],
        )
        assert.deepEqual(withoutMessageCache(body).messages[0].content, blocks, 'only cache markers change')
        assert.deepEqual(messageMarkers(body), [
          { index: 0, blockIndex: blocks.length - 3, type: 'text', ttl: cacheTtl },
          { index: 0, blockIndex: blocks.length - 1, type: 'text', ttl: cacheTtl },
        ])
        for (const block of body.messages[0].content.filter((block) => block.cache_control)) {
          assert.deepEqual(block.cache_control, { type: 'ephemeral', ttl: cacheTtl })
        }
        if (previous) {
          let shared = 0
          const currentBlocks = withoutMessageCache(body).messages[0].content
          const previousBlocks = withoutMessageCache(previous).messages[0].content
          while (shared < previousBlocks.length && currentBlocks[shared].text === previousBlocks[shared].text) shared++
          assert.equal(shared, blocks.length - 3)
          const previousAnchor = messageMarkers(previous)[0].blockIndex
          assert.equal(previousAnchor, shared - 1, "the previous history marker is inside this turn's stable prefix")
          assert.deepEqual(currentBlocks.slice(0, shared), previousBlocks.slice(0, shared))
        }
        previous = body
      }
    })
  }
}

test('cli-hop single-user history anchor starts at four nonempty text blocks', () => {
  for (let count = 1; count <= 4; count++) {
    const body = prepareCliHopBody({
      model: 'claude-sonnet-5.5',
      messages: [
        { role: 'user', content: Array.from({ length: count }, (_, i) => ({ type: 'text', text: `Block ${i}.` })) },
      ],
    })
    assert.deepEqual(
      messageMarkers(body).map((hit) => hit.blockIndex),
      count < 4 ? [count - 1] : [1, 3],
    )
  }
})

for (const [kind, block] of [
  ['image', { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } }],
  ['document', { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'fixture' } }],
  ['tool_result', { type: 'tool_result', tool_use_id: 'fixture', content: 'result' }],
  ['thinking', { type: 'thinking', thinking: 'history', signature: 'sig'.repeat(10) }],
  ['redacted_thinking', { type: 'redacted_thinking', data: 'fixture' }],
  ['blank text', { type: 'text', text: '  ' }],
]) {
  test(`cli-hop does not add a history marker to a single user with ${kind}`, () => {
    const body = prepareCliHopBody({
      model: 'claude-sonnet-5.5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First.' },
            block,
            { type: 'text', text: 'History.' },
            { type: 'text', text: 'Tail.' },
          ],
        },
      ],
    })
    assert.equal(messageMarkers(body).length, 1)
    assert.equal(messageMarkers(body)[0].blockIndex, body.messages[0].content.length - 1)
  })
}

test('generic HTTP rewrite keeps only the tail marker for a single user with text blocks', () => {
  const incoming = freezeTree({
    messages: [
      { role: 'user', content: Array.from({ length: 106 }, (_, i) => ({ type: 'text', text: `Block ${i}.` })) },
    ],
  })
  const body = applyMessageBreakpoints(incoming, '5m', 'rewrite')
  assert.deepEqual(messageMarkers(body), [{ index: 0, blockIndex: 105, type: 'text', ttl: '5m' }])
  assert.deepEqual(withoutMessageCache(body), incoming)
})

test('cli-hop keeps Opus multi-message anchors with a multi-block last user', () => {
  const body = prepareCliHopBody({
    model: 'claude-opus-5.5',
    messages: [
      { role: 'user', content: 'First.' },
      { role: 'assistant', content: 'Answer.' },
      { role: 'user', content: 'Second.' },
      { role: 'assistant', content: 'Answer again.' },
      { role: 'user', content: Array.from({ length: 106 }, (_, i) => ({ type: 'text', text: `Block ${i}.` })) },
    ],
  })
  assert.deepEqual(messageMarkers(body), [
    { index: 2, blockIndex: 0, type: 'text', ttl: '1h' },
    { index: 4, blockIndex: 105, type: 'text', ttl: '1h' },
  ])
})

test('cli-hop drops caller system/tools markers and restamps last plus penultimate user', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      system: [{ type: 'text', text: 'caller', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      cache_control: { type: 'ephemeral', ttl: '5m' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'u1', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: [{ type: 'text', text: 'u2' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
      ],
    },
    { cacheTtl: '5m' },
  )
  assert.equal(body.cache_control, undefined)
  assert.equal(body.tools[0].cache_control, undefined)
  assert.equal(body.system[0].cache_control, undefined)
  assert.deepEqual(messageMarkers(body), [
    { index: 0, blockIndex: 0, type: 'text', ttl: '5m' },
    { index: 3, blockIndex: 0, type: 'text', ttl: '5m' },
  ])
})

test('cli-hop short history only marks the last message', () => {
  const body = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ],
  })
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  )
  assert.deepEqual(messageMarkers(body), [{ index: 2, blockIndex: 0, type: 'text', ttl: '1h' }])
})

test('cli-hop does not mark thinking blocks', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'answer' },
            { type: 'thinking', thinking: 'hidden', signature: 'sig'.repeat(8) },
          ],
        },
      ],
    },
    { cacheTtl: '1h' },
  )
  assert.deepEqual(body.messages.at(-1).content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(body.messages.at(-1).content[1].cache_control, undefined)
})

test('cli-hop uses the inbound session TTL on both message anchors', () => {
  const body = prepareCliHopBody(
    {
      model: 'claude-sonnet-5',
      max_tokens: 256,
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
      ],
    },
    { cacheTtl: '1h' },
  )
  assert.deepEqual(
    messageMarkers(body).map((hit) => hit.ttl),
    ['1h', '1h'],
  )
})

test('Claude Code turns stay a content prefix of the next one, from turn 1 on', () => {
  const reminder = (text) => ({ role: 'system', content: text })
  const budget = (left) => reminder(`<total_tokens>${left} tokens left</total_tokens>`)
  const turn = (messages) =>
    prepareCliHopBody({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      system: [{ type: 'text', text: 'main prompt' }],
      messages,
    })
  const turns = [
    [{ role: 'user', content: 'u1' }, reminder('SessionStart hook context')],
    [{ role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' }, budget(14930105)],
    [{ role: 'assistant', content: 'a2' }, { role: 'user', content: 'u3' }, budget(14928642)],
  ]
  let history = []
  let previous = null
  for (const added of turns) {
    history = [...history, ...added]
    const body = turn(history)
    assert.equal(body.messages.at(-1).role, 'system')
    if (previous) {
      assert.deepEqual(body.system, previous.system)
      assert.deepEqual(
        withoutMessageCache(body).messages.slice(0, previous.messages.length),
        withoutMessageCache(previous).messages,
      )
    }
    previous = body
  }
})

test('cli-hop lifts role=system turns for models that reject them', () => {
  const body = prepareCliHopBody({
    model: 'claude-haiku-4-5',
    max_tokens: 256,
    messages: [
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'reminder' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ],
  })
  assert.ok(body.messages.every((message) => message.role !== 'system'))
  assert.equal(body.system.at(-1).text, 'reminder')
})

test('cli-hop makes Opus 5.5 acceptable to Claude Code 2.1.280', () => {
  const body = prepareCliHopBody({
    model: 'claude-opus-5.5',
    thinking: { type: 'enabled', budget_tokens: 8000, display: 'summarized' },
    output_config: { effort: 'high' },
    tool_choice: { type: 'tool', name: 'get_weather' },
    tools: [
      { name: 'get_weather', input_schema: { type: 'object' } },
      { type: 'computer_20251124', name: 'computer' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(body.model, 'claude-opus-5-5')
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.equal(body.thinking.budget_tokens, undefined)
  assert.equal(body.output_config.effort, 'high')
  assert.deepEqual(body.tool_choice, { type: 'auto' })
  assert.equal(body.tools.find((tool) => tool.name === 'get_weather').strict, true)
  assert.equal(body.tools.find((tool) => tool.name === 'computer').type, 'computer_toolset_20260801')

  const filled = prepareCliHopBody({
    model: 'claude-opus-5-5',
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(filled.thinking.type, 'adaptive')
  assert.equal(filled.thinking.budget_tokens, undefined)
  assert.equal(filled.output_config.effort, 'medium')

  const opus5 = prepareCliHopBody({
    model: 'claude-opus-5',
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(opus5.thinking.type, 'disabled')
  assert.equal(opus5.output_config.effort, 'high')
})
