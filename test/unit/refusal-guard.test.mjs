import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RefusalGuardsRepo } from '../../src/lib/db/repos/refusal-guards-repo.mjs'
import {
  REFUSAL_GUARD_MESSAGE,
  REFUSAL_GUARD_SETTING,
  isRefusalGuardEnabled,
  isUpstreamRefusal,
  refusalFingerprint,
  refusalGuardError,
} from '../../src/lib/core/refusal-guard.mjs'
import { detectDistill } from '../../src/lib/core/distill-detect.mjs'

function body(user, extra = {}) {
  return {
    model: extra.model || 'claude-opus-5',
    max_tokens: extra.max_tokens || 64,
    stream: extra.stream === true,
    system: extra.system,
    tools: extra.tools,
    messages: [{ role: 'user', content: user }],
  }
}

test('fingerprint ignores stream and max_tokens, includes model', () => {
  const a = refusalFingerprint(body('Return exactly STREAM_5m_OK.', { stream: true, max_tokens: 64 }))
  const b = refusalFingerprint(body('Return exactly STREAM_5m_OK.', { stream: false, max_tokens: 128 }))
  const c = refusalFingerprint(body('Return exactly STREAM_5m_OK.', { model: 'claude-opus-4-8' }))
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('envelope persistable JSON bodies keep distinct fingerprints', () => {
  const a = refusalFingerprint(
    body(
      'thread_id: 01a057ba-d606-7255-a932-a2cfad833afe\n\nPersistable response items (JSON):\n[{"role":"user","text":"再windows 重装 cli"}]',
    ),
  )
  const b = refusalFingerprint(
    body(
      'thread_id: 01a0bb2c-a363-7707-8691-ba523befae35\n\nPersistable response items (JSON):\n[{"role":"user","text":"pull最新源码"}]',
    ),
  )
  assert.notEqual(a, b)
})

test('stop_reason=refusal and Usage Policy API Error are cacheable; distill is not', () => {
  assert.equal(
    isUpstreamRefusal({
      body: {
        error: {
          message:
            'Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup)',
        },
      },
    }),
    true,
  )
  assert.equal(
    isUpstreamRefusal(
      { status: 400, terminalState: 'rejected' },
      {
        error_message:
          'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup)',
      },
    ),
    true,
  )
  assert.equal(isUpstreamRefusal({ finalState: 'content_filter' }), true)
  assert.equal(isUpstreamRefusal({ body: { stop_reason: 'refusal' } }), true)
  assert.equal(
    isUpstreamRefusal({ body: { content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] } }),
    true,
  )
  assert.equal(isUpstreamRefusal({ body: { error: { code: 'distill_blocked', message: '不允许蒸馏' } } }), false)
})

test('network, watchdog and truncated-stream errors are not remembered as refusals', () => {
  for (const [code, message] of [
    ['upstream_network_error', 'provider error: provider error: Connection error.'],
    ['upstream_stream_incomplete', 'job idle timeout: no CLI frame for 180 seconds'],
    ['worker_timeout', 'slot worker idle timeout after 180000ms'],
    ['upstream_stream_interrupted', 'stream closed before message_stop'],
  ]) {
    assert.equal(isUpstreamRefusal({ body: { error: { type: 'api_error', code, message } } }), false, code)
  }
})

test('zero inject still allows distill skip while refusal fingerprint is independent', () => {
  const inbound = body('Please reason step by step, and put your final answer within \\boxed{}', {
    max_tokens: 16384,
  })
  const distill = detectDistill({ inbound, body: inbound, zeroInject: true })
  assert.equal(distill.action, 'pass')
  assert.ok(refusalFingerprint(inbound))
})

test('remember then lookup hits the same prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const req = body('Return exactly CACHE_30_5m_OK.')
    const fp = refusalFingerprint(req)
    assert.equal(repo.get(fp), null)
    repo.remember({
      fingerprint: fp,
      model: req.model,
      requestId: 'req-1',
      errorMessage: 'violate our Usage Policy',
      preview: 'Return exactly CACHE_30_5m_OK.',
    })
    const hit = repo.get(fp)
    assert.ok(hit)
    assert.equal(hit.hit_count, 0)
    const bumped = repo.hit(fp)
    assert.equal(bumped.hit_count, 1)
    const other = refusalFingerprint(body('Return exactly CACHE_30_5m_OK.', { model: 'claude-opus-4-8' }))
    assert.equal(repo.get(other), null)
  } finally {
    db.close()
  }
})

test('timed refusal expires and no longer blocks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const req = body('pause this 500')
    const fp = refusalFingerprint(req)
    repo.remember({
      fingerprint: fp,
      model: req.model,
      requestId: 'req-500',
      errorMessage: 'upstream 503',
      preview: 'pause this 500',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    assert.equal(repo.get(fp), null)
    assert.equal(repo.list().length, 0)
  } finally {
    db.close()
  }
})
test('guard error is a non-retryable HTTP 403 permission error', () => {
  const err = refusalGuardError('abc')
  assert.equal(err.status, 403)
  assert.equal(err.body.error.code, 'refusal_guard')
  assert.equal(err.body.error.type, 'permission_error')
  assert.equal(err.body.error.message, REFUSAL_GUARD_MESSAGE)
  assert.deepEqual(err.body.error.details, { blocked_by: 'exact', retryable: false })
  assert.equal(err.body.error.request_id, 'abc')
  assert.notEqual(err.body.error.code, 'distill_blocked')
})

test('device refusal identifies a prior device block and exposes only a valid source request UUID', () => {
  const sourceRequestId = '36e239bf-7e70-4a79-80fd-c8a717ff464b'
  const err = refusalGuardError('current', { blockedBy: 'device', sourceRequestId })
  assert.match(err.body.error.message, /client device is blocked/)
  assert.match(err.body.error.message, /administrator for review/)
  assert.doesNotMatch(err.body.error.message, /previously refused this exact request/)
  assert.deepEqual(err.body.error.details, {
    blocked_by: 'device',
    retryable: false,
    source_request_id: sourceRequestId,
  })
  for (const invalid of ['prompt contents', 'sk-test-secret', '36e239bf-7e70-4a79-80fd-c8a717ff464b\nsecret']) {
    const invalidError = refusalGuardError('current', { blockedBy: 'device', sourceRequestId: invalid })
    assert.equal(invalidError.body.error.details.source_request_id, undefined)
    assert.equal(JSON.stringify(invalidError).includes(invalid), false)
  }
  const exact = refusalGuardError('current', { sourceRequestId })
  assert.equal(exact.body.error.details.source_request_id, undefined)
})

test('list remove and clear', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refusal-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new RefusalGuardsRepo(db)
    const a = refusalFingerprint(body('A'))
    const b = refusalFingerprint(body('B'))
    repo.remember({ fingerprint: a, model: 'claude-opus-5', preview: 'A' })
    repo.remember({ fingerprint: b, model: 'claude-opus-5', preview: 'B' })
    assert.equal(repo.count(), 2)
    assert.equal(repo.list().length, 2)
    assert.equal(repo.remove(a), true)
    assert.equal(repo.count(), 1)
    assert.equal(repo.clear(), 1)
    assert.equal(repo.count(), 0)
  } finally {
    db.close()
  }
})

test('panel setting and env can disable the guard', () => {
  const settings = new Map([[REFUSAL_GUARD_SETTING, true]])
  const read = (key, fb) => (settings.has(key) ? settings.get(key) : fb)
  assert.equal(isRefusalGuardEnabled(read), true)
  settings.set(REFUSAL_GUARD_SETTING, false)
  assert.equal(isRefusalGuardEnabled(read), false)
  const prev = process.env.KIN_REFUSAL_GUARD
  process.env.KIN_REFUSAL_GUARD = '0'
  try {
    settings.set(REFUSAL_GUARD_SETTING, true)
    assert.equal(isRefusalGuardEnabled(read), false)
  } finally {
    if (prev == null) delete process.env.KIN_REFUSAL_GUARD
    else process.env.KIN_REFUSAL_GUARD = prev
  }
})
