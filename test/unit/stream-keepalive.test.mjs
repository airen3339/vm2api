import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
import {
  buildClaudeCodeNoopDeltaKeepalive,
  buildPingKeepalive,
  compareSemver,
  createDownstreamKeepalive,
  observeKeepaliveEvent,
  resolveKeepaliveChunk,
  shouldUseClaudeCodeNoopDeltaKeepalive,
} from '../../src/lib/protocol/stream-keepalive.mjs'

test('noop delta keepalive is for official CLI 2.1.193+', () => {
  assert.equal(shouldUseClaudeCodeNoopDeltaKeepalive('claude-cli/2.1.193 (external, cli)'), true)
  assert.equal(shouldUseClaudeCodeNoopDeltaKeepalive('claude-cli/2.1.241 (external, sdk-cli)'), true)
  assert.equal(shouldUseClaudeCodeNoopDeltaKeepalive('claude-cli/2.1.187 (external, cli)'), false)
  assert.equal(shouldUseClaudeCodeNoopDeltaKeepalive('kin-console-test/1.0'), false)
  assert.equal(compareSemver('2.1.193', '2.1.193'), 0)
})

test('keepalive chunk uses empty delta during tool_use for new CLI', () => {
  let state = { blockIndex: -1, deltaType: '' }
  state = observeKeepaliveEvent(state, {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', name: 'Agent' },
  })
  const chunk = resolveKeepaliveChunk({
    protocol: 'anthropic.messages',
    userAgent: 'claude-cli/2.1.241 (external, sdk-cli)',
    state,
  })
  assert.equal(chunk, buildClaudeCodeNoopDeltaKeepalive(1, 'input_json_delta'))
  assert.match(chunk, /"partial_json":""/)
})

test('keepalive chunk uses ping for older CLI or after block stop', () => {
  let state = observeKeepaliveEvent(
    { blockIndex: -1, deltaType: '' },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
  )
  assert.equal(
    resolveKeepaliveChunk({
      protocol: 'anthropic.messages',
      userAgent: 'claude-cli/2.1.187 (external, cli)',
      state,
    }),
    buildPingKeepalive(),
  )
  state = observeKeepaliveEvent(state, { type: 'content_block_stop', index: 0 })
  assert.equal(
    resolveKeepaliveChunk({
      protocol: 'anthropic.messages',
      userAgent: 'claude-cli/2.1.241 (external, sdk-cli)',
      state,
    }),
    buildPingKeepalive(),
  )
})

test('OpenAI protocol keepalive is an SSE comment', () => {
  assert.equal(resolveKeepaliveChunk({ protocol: 'openai.chat' }), ': keepalive\n\n')
})

test('createDownstreamKeepalive emits a ping after idle', async () => {
  const writes = []
  const keepalive = createDownstreamKeepalive({
    intervalMs: 20,
    userAgent: 'claude-cli/2.1.187 (external, cli)',
    protocol: 'anthropic.messages',
    write: (chunk) => writes.push(chunk),
  })
  keepalive.start()
  keepalive.observeLine('data: {"type":"message_start","message":{}}')
  await new Promise((resolve) => setTimeout(resolve, 80))
  keepalive.stop()
  assert.ok(writes.some((chunk) => chunk.includes('event: ping')))
})

test('start alone does not ping before the first upstream event (REQ-0429)', async () => {
  const writes = []
  const keepalive = createDownstreamKeepalive({
    intervalMs: 20,
    userAgent: 'claude-cli/2.1.187 (external, cli)',
    protocol: 'anthropic.messages',
    write: (chunk) => writes.push(chunk),
  })
  keepalive.start()
  await new Promise((resolve) => setTimeout(resolve, 80))
  keepalive.stop()
  assert.equal(writes.length, 0)
})

test('keepalive arm starts pinging before the first upstream event', async () => {
  const writes = []
  const keepalive = createDownstreamKeepalive({
    intervalMs: 20,
    userAgent: 'claude-cli/2.1.187 (external, cli)',
    protocol: 'anthropic.messages',
    write: (chunk) => writes.push(chunk),
  })
  keepalive.arm()
  await new Promise((resolve) => setTimeout(resolve, 80))
  keepalive.stop()
  assert.ok(writes.some((chunk) => chunk.includes('event: ping')))
})

test('handleProtocol streaming attempt arms downstream keepalive before TTFT', () => {
  const src = fs.readFileSync(path.join(root, 'src/lib/protocol/handle-protocol.mjs'), 'utf8')
  const marker = 'const keepalive = createDownstreamKeepalive({'
  const idx = src.indexOf(marker)
  assert.ok(idx > 0)
  const chunk = src.slice(idx, idx + 600)
  assert.match(chunk, /keepalive\.arm\(\)/)
  assert.doesNotMatch(chunk, /keepalive\.start\(\)/)
})
