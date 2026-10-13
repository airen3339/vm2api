import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

test('protocol distinguishes local/model/RPM 429 from a confirmed account limit', async () => {
  for (const message of [
    'Fable requires an available Max account',
    'All accounts are busy',
    'Rate limit exceeded: requests per minute',
    "You've hit your limit",
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-protocol-quota-'))
    const quota = new AccountQuota({ dataDir: root, config: {} })
    quota.ingestHeaders('account-1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.18',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': new Date(Date.now() + 4 * 3600_000).toISOString(),
    })
    let calls = 0
    const response = { headersSent: false, on() {}, once() {}, off() {}, end() {} }
    const handler = createHandleProtocol({
      cfg: {
        rewrite: { enabled: false },
        intercept: { rules: [] },
        distill: { enabled: false },
        limits: { max_body_bytes: 1024 * 1024 },
        paths: { data: root, project: root },
      },
      json: (_res, status) => {
        response.statusCode = status
      },
      writeSSEHeaders() {},
      readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] }),
      requireAuth: () => true,
      requestLog: { start: () => ({ request_id: 'quota-regression' }), finish() {} },
      stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
      accountQuota: quota,
      apiKeyStore: {},
      stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
      routingConfig: { compatibility: {}, failover: {} },
      groupsRepo: { rateMultiplier: () => 1 },
      failoverRunner: {
        async run() {
          calls += 1
          return {
            ok: false,
            status: 429,
            via: 'pool-failover',
            accountId: 'account-1',
            vmId: 'vm-01',
            headers: {},
            body: { error: { type: 'rate_limit_error', message } },
          }
        },
      },
    })
    try {
      await handler.handleProtocol(
        {
          method: 'POST',
          url: '/v1/messages',
          headers: {},
          apiKeyKind: 'master',
          once() {},
          off() {},
        },
        response,
        'anthropic.messages',
        '/v1/messages',
      )
      assert.equal(calls, 1)
      assert.equal(response.statusCode, 429)
      const confirmed = message === "You've hit your limit"
      const window = quota.repo.get('account-1').unified.headers['5h']
      assert.equal(window.status, confirmed ? 'rejected' : 'allowed', message)
      assert.equal(quota.canAccept('account-1').ok, !confirmed, message)
    } finally {
      quota.db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('protocol marks a provider 429 as account exhaustion even without CLI limit text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-protocol-provider-429-'))
  const quota = new AccountQuota({ dataDir: root, config: {} })
  quota.ingestHeaders('account-1', {
    'anthropic-ratelimit-unified-5h-utilization': '0.18',
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-reset': new Date(Date.now() + 4 * 3600_000).toISOString(),
  })
  const response = { headersSent: false, on() {}, once() {}, off() {}, end() {} }
  const handler = createHandleProtocol({
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024 },
      paths: { data: root, project: root },
    },
    json: (_res, status) => {
      response.statusCode = status
    },
    writeSSEHeaders() {},
    readBody: async () => ({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello' }] }),
    requireAuth: () => true,
    requestLog: { start: () => ({ request_id: 'provider-429' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: quota,
    apiKeyStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfig: { compatibility: {}, failover: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      async run() {
        return {
          ok: false,
          status: 429,
          via: 'go-worker-stream',
          accountId: 'account-1',
          vmId: 'vm-01',
          headers: {},
          body: { error: { type: 'rate_limit_error', message: 'upstream throttled' } },
        }
      },
    },
  })
  try {
    await handler.handleProtocol(
      {
        method: 'POST',
        url: '/v1/messages',
        headers: {},
        apiKeyKind: 'master',
        once() {},
        off() {},
      },
      response,
      'anthropic.messages',
      '/v1/messages',
    )
    assert.equal(response.statusCode, 429)
    assert.equal(quota.repo.get('account-1').unified.headers['5h'].status, 'rejected')
    assert.equal(quota.canAccept('account-1').ok, false)
  } finally {
    quota.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
