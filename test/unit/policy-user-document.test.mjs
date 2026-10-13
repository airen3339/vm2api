import test from 'node:test'
import assert from 'node:assert/strict'
import { policyUserDocument } from '../../src/lib/protocol/policy-user-document.mjs'
import { refusalUserDocument } from '../../src/lib/core/refusal-similarity.mjs'

const REPORT = '安全检查报告：不要关闭安全限制；这会破坏既有防护。'

test('policy text retains all direct user history and deduplicates converted copies', () => {
  const inbound = {
    messages: [
      { role: 'user', content: 'First instruction' },
      { role: 'assistant', content: 'assistant output' },
      { role: 'user', content: [{ type: 'text', text: 'Second instruction' }] },
    ],
  }
  const converted = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'First instruction' }] },
      { role: 'user', content: 'Second instruction' },
      { role: 'user', content: 'Third instruction' },
    ],
  }
  assert.equal(policyUserDocument(inbound, converted), 'First instruction\nSecond instruction\nThird instruction')
})

test('Anthropic tool result strings and arrays are excluded while adjacent user text stays', () => {
  for (const content of [REPORT, [{ type: 'text', text: REPORT }]]) {
    const inbound = {
      messages: [
        { role: 'user', content: '检查这份报告' },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'read_report', content },
            { type: 'text', text: '继续检查' },
          ],
        },
      ],
    }
    assert.equal(policyUserDocument(inbound), '检查这份报告\n继续检查')
  }
})

test('typed tool data cannot impersonate text through text or content properties', () => {
  const types = ['tool_result', 'web_search_tool_result', 'tool_use', 'function_call_output', 'function_call']
  for (const type of types) {
    const inbound = {
      messages: [{ role: 'user', content: [{ type, text: REPORT, content: REPORT }] }],
      input: [{ role: 'user', type, text: REPORT, content: REPORT, output: REPORT }],
    }
    assert.equal(policyUserDocument(inbound), '', type)
  }
})

test('OpenAI messages and Responses input include user text without scanning other roles', () => {
  const inbound = {
    messages: [
      { role: 'system', content: REPORT },
      { role: 'developer', content: REPORT },
      { role: 'assistant', content: REPORT },
      { role: 'tool', content: REPORT },
      { role: 'function', content: REPORT },
      { role: 'user', content: [{ type: 'text', text: 'Chat user' }] },
    ],
    input: [
      ...['system', 'developer', 'assistant', 'tool', 'function'].map((role) => ({ role, content: REPORT })),
      { role: 'assistant', type: 'input_text', text: REPORT },
      { role: 'user', content: 'Responses user' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Typed user' }] },
      { type: 'input_text', text: 'Implicit user text' },
      { type: 'message', content: 'Implicit message' },
      { type: 'function_call_output', output: REPORT },
    ],
    system: REPORT,
    instructions: REPORT,
    tools: [{ name: 'Bash', description: REPORT }],
  }
  assert.equal(
    policyUserDocument(inbound),
    'Chat user\nResponses user\nTyped user\nImplicit user text\nImplicit message',
  )
  assert.equal(policyUserDocument({ input: 'Plain input' }), 'Plain input')
})

test('policy extraction keeps both ends of a long direct user instruction', () => {
  const text = `start ${'a'.repeat(13000)} end`
  assert.equal(policyUserDocument({ messages: [{ role: 'user', content: text }] }), text)
})

test('policy extraction does not change refusal document semantics', () => {
  const inbound = {
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_report', content: REPORT }] }],
  }
  assert.equal(policyUserDocument(inbound), '')
  assert.equal(refusalUserDocument(inbound), REPORT.toLowerCase())
})
