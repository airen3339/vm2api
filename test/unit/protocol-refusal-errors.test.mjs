import test from 'node:test'
import assert from 'node:assert/strict'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

test('AUP mapping logs the refusal while retaining the original upstream error', () => {
  const handler = createHandleProtocol({})
  const logBag = { hop_meta: { existing: 'retained' }, classifier: { purpose: 'auto_mode_classifier' } }
  const message = 'Claude Code is unable to respond to this request, which appears to violate our Usage Policy.'
  const mapped = handler.mapProtocolClientError(
    {
      status: 400,
      body: { error: { type: 'invalid_request_error', code: 'upstream_invalid_request', message } },
    },
    logBag,
    'upstream_error',
  )
  assert.equal(mapped.status, 403)
  assert.equal(mapped.body.error.code, 'refusal_guard')
  assert.equal(mapped.body.error.details.retryable, false)
  assert.equal(logBag.error_code, 'refusal_guard')
  assert.equal(logBag.error_message, message)
  assert.equal(logBag.hop_meta.existing, 'retained')
  assert.deepEqual(logBag.hop_meta.refusal, {
    blocked_by: 'upstream',
    retryable: false,
    upstream_status: 400,
    upstream_type: 'invalid_request_error',
    upstream_code: 'upstream_invalid_request',
    upstream_message: message,
  })
  assert.equal(logBag.classifier.error.code, 'upstream_invalid_request')
})

test('transport failures retain their error class and do not gain refusal attribution', () => {
  const handler = createHandleProtocol({})
  const logBag = {}
  const mapped = handler.mapProtocolClientError(
    {
      status: 502,
      body: { error: { type: 'api_error', code: 'upstream_network_error', message: 'Connection error.' } },
    },
    logBag,
    'upstream_error',
  )
  assert.equal(mapped.status, 502)
  assert.equal(logBag.error_code, 'upstream_network_error')
  assert.equal(logBag.hop_meta, undefined)
})
