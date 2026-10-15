import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { MihomoManager, managedProxyId } from '../../src/lib/mihomo/manager.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { disableVmForProxy, getVm, setVmSchedulable } from '../../src/lib/vm/vm-registry.mjs'
import { BackupService } from '../../src/lib/admin/backup-service.mjs'

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-review-'))
  const dataDir = path.join(root, 'data')
  const runtime = {
    installed: true,
    running: false,
    async start() {
      this.running = true
    },
    async stop() {
      this.running = false
    },
    async apply() {},
  }
  const pool = new ProxyPool({ dataDir, ...options.pool })
  const manager = new MihomoManager({ dataDir, proxyPool: pool, runtime, probeImpl: options.probeImpl })
  t.after(async () => {
    await manager.close()
    pool.stopScheduler()
    pool.db.close()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('vm2api-review-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, dataDir, runtime, pool, manager }
}
async function exported(manager, count = 1) {
  await manager.perform({
    action: 'dynamic_add',
    text: Array.from({ length: count }, (_, i) => `http://node${i}.example:8000#node${i}`).join('\n'),
  })
  await manager.perform({ action: 'start' })
  const ids = manager.status().nodes.map((n) => n.id)
  await manager.perform({ action: 'node_export', ids })
  return ids
}

test('R1: a recovered outlet resumes the slot disabled by that outlet', async (t) => {
  let schedulable = true
  const events = []
  const { manager, pool } = fixture(t, {
    pool: {
      onDisableVm: (vmId, reason) => {
        schedulable = false
        events.push(['disable', vmId, reason])
      },
      onEnableVm: (vmId, reason) => {
        schedulable = true
        events.push(['enable', vmId, reason])
      },
    },
  })
  const [id] = await exported(manager)
  assert.equal(pool.bind(managedProxyId(id), 'slot-a').ok, true)
  await manager.perform({ action: 'stop' })
  await manager.perform({ action: 'start' })
  pool.probeOne = async () => ({ ok: true, scope: 'socks', latency_ms: 1 })
  await pool.probeById(managedProxyId(id))
  t.diagnostic(JSON.stringify({ events, proxyStatus: pool.snapshot().proxies[0].status, schedulable }))
  assert.equal(schedulable, true)
})

test('R2: rejected rebind keeps the previous fixed outlet', async (t) => {
  const { manager, pool } = fixture(t)
  const [id] = await exported(manager)
  const oldId = managedProxyId(id)
  const otherId = pool.importLines('127.0.0.1:31001').items[0].id
  pool.state.config.bind_limit = 1
  assert.equal(pool.bind(oldId, 'slot-a').ok, true)
  assert.equal(pool.bind(otherId, 'slot-b').ok, true)
  const result = pool.bind(otherId, 'slot-a')
  assert.equal(result.error, 'proxy_bind_limit')
  const oldBinding = pool.snapshot().proxies.find((p) => p.id === oldId).bound_vm_ids
  t.diagnostic(JSON.stringify({ result: result.error, oldBinding }))
  assert.deepEqual(oldBinding, ['slot-a'])
})

test('R3: failed recheck clears obsolete exit information', async (t) => {
  let count = 0
  const { manager } = fixture(t, {
    probeImpl: async () =>
      ++count === 1
        ? {
            success: true,
            latency_ms: 5,
            geo_ok: true,
            geo: { ip: '192.0.2.2', country_code: 'US' },
            quality: { passed: 3, total: 3 },
          }
        : { success: false, latency_ms: 8000, geo_ok: false, quality: { passed: 0, total: 3 } },
  })
  const [id] = await exported(manager)
  await manager.test(id, true)
  await manager.test(id, true)
  const check = manager.status().nodes[0].check
  t.diagnostic(JSON.stringify(check))
  assert.equal(check.geo, undefined)
})

test('R4: a saved custom proxy name survives an unrelated source rename', async (t) => {
  const { manager, pool } = fixture(t)
  const [id] = await exported(manager)
  assert.equal(pool.update(managedProxyId(id), { label: 'my-fixed-outlet' }).ok, true)
  await manager.perform({ action: 'source_rename', id: manager.status().sources[0].id, label: 'renamed-source' })
  const label = pool.snapshot().proxies[0].label
  t.diagnostic(JSON.stringify({ label }))
  assert.equal(label, 'my-fixed-outlet')
})

test('R5: syncing 25 managed proxies does not rewrite the whole pool once per node', async (t) => {
  const { manager, pool } = fixture(t)
  await exported(manager, 25)
  let transactions = 0,
    rows = 0
  const replaceAll = pool.repo.replaceAll.bind(pool.repo)
  pool.repo.replaceAll = (list) => {
    transactions++
    rows += list.length
    return replaceAll(list)
  }
  const started = performance.now()
  await manager.perform({ action: 'source_rename', id: manager.status().sources[0].id, label: 'renamed-source' })
  t.diagnostic(JSON.stringify({ transactions, rows, ms: Math.round(performance.now() - started) }))
  assert.ok(transactions <= 1, `expected <=1 whole-pool write, got ${transactions}`)
})

test('R6: a panel backup restores the persisted Mihomo configuration', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-review-backup-'))
  const dataDir = path.join(root, 'data')
  openDatabase({ dataDir })
  const service = new BackupService({ dataDir, projectRoot: root })
  t.after(() => {
    service.stopScheduler()
    closeDatabase()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('vm2api-review-backup-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(dataDir, 'mihomo'))
  fs.writeFileSync(
    path.join(dataDir, 'mihomo', 'settings.json'),
    JSON.stringify({ version: 1, sources: [{ id: 'test-source' }] }),
  )
  const record = service.createBackup()
  const listing = spawnSync('tar', ['-tzf', record.file_path], { encoding: 'utf8' })
  assert.equal(listing.status, 0)
  fs.writeFileSync(
    path.join(dataDir, 'mihomo', 'settings.json'),
    JSON.stringify({ version: 1, sources: [{ id: 'post-backup-source' }] }),
  )
  const restored = await service.restoreBackup(record.id)
  const afterRestore = JSON.parse(fs.readFileSync(path.join(dataDir, 'mihomo', 'settings.json'), 'utf8'))
  t.diagnostic(
    JSON.stringify({
      status: record.status,
      includes: record.includes,
      entries: listing.stdout.trim().split(/\r?\n/),
      restoreReportedOk: restored.ok,
      sourceAfterRestore: afterRestore.sources[0].id,
    }),
  )
  assert.match(listing.stdout, /mihomo\/settings\.json/)
  assert.equal(afterRestore.sources[0].id, 'test-source')
})

test('R7: removing an unbound node cannot delete a slot binding acquired during apply', async (t) => {
  const { manager, pool, runtime } = fixture(t)
  const [id] = await exported(manager)
  let begin, release
  const entered = new Promise((resolve) => {
    begin = resolve
  })
  runtime.apply = () => {
    begin()
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const removal = manager.perform({ action: 'node_unexport', id })
  await entered
  const binding = pool.bind(managedProxyId(id), 'slot-during-apply')
  release()
  await removal
  const surviving = pool.snapshot().proxies.find((p) => p.id === managedProxyId(id))
  t.diagnostic(JSON.stringify({ bindAccepted: binding.ok, proxyRemains: !!surviving }))
  assert.ok(!binding.ok || surviving?.bound_vm_ids.includes('slot-during-apply'))
})

import { parseSubscription } from '../../src/lib/mihomo/config.mjs'

test('R8: IP version preferences are accepted and unknown values rejected', () => {
  for (const version of ['dual', 'ipv4', 'ipv6', 'ipv4-prefer', 'ipv6-prefer']) {
    const node = { type: 'socks5', server: 'node.example', port: 1080, 'ip-version': version }
    assert.equal(parseSubscription(JSON.stringify({ proxies: [node] }))[0].config['ip-version'], version)
  }
  assert.throws(
    () =>
      parseSubscription(
        JSON.stringify({ proxies: [{ type: 'socks5', server: 'node.example', port: 1080, 'ip-version': 'direct' }] }),
      ),
    /ip-version/,
  )
})

test('stopped managed outlets cannot be resurrected by a late health probe', async (t) => {
  let enabled = 0
  const { manager, pool } = fixture(t, { pool: { onEnableVm: () => enabled++ } })
  const [id] = await exported(manager)
  pool.bind(managedProxyId(id), 'slot-a')
  await manager.perform({ action: 'stop' })
  pool.probeOne = async () => ({ ok: true, latency_ms: 1 })
  await pool.probeById(managedProxyId(id))
  assert.equal(pool.snapshot().proxies[0].enabled, false)
  assert.equal(enabled, 0)
})

test('restart recovery retains the reason until the first successful probe', async (t) => {
  let enabled = 0
  const { manager, pool, dataDir, runtime } = fixture(t, { pool: { onEnableVm: () => enabled++ } })
  const [id] = await exported(manager)
  pool.bind(managedProxyId(id), 'slot-a')
  await manager.close()
  const restarted = new MihomoManager({ dataDir, proxyPool: pool, runtime })
  try {
    await restarted.restore()
    assert.equal(enabled, 0)
    assert.equal(pool.snapshot().proxies[0].last_error, 'mihomo_unavailable')
    pool.probeOne = async () => ({ ok: true, latency_ms: 1 })
    await pool.probeById(managedProxyId(id))
    assert.equal(enabled, 1)
  } finally {
    await restarted.close()
  }
})

test('failed removal releases its binding lock and retains the previous outlet', async (t) => {
  const { manager, pool, runtime } = fixture(t)
  const [id] = await exported(manager)
  const apply = runtime.apply
  let fail = true
  runtime.apply = async () => {
    if (fail) {
      fail = false
      throw new Error('apply failed')
    }
  }
  await assert.rejects(manager.perform({ action: 'node_unexport', id }))
  runtime.apply = apply
  assert.equal(manager.state.bindings[id].exported, true)
  assert.equal(pool.bind(managedProxyId(id), 'slot-a').ok, true)
  await assert.rejects(manager.perform({ action: 'node_unexport', id }), { code: 'proxy_in_use' })
  assert.equal(pool.managedBusy, false)
})

test('a changed managed batch saves once and an unchanged batch does not save', async (t) => {
  const { manager, pool } = fixture(t)
  await exported(manager, 25)
  let saves = 0
  const replaceAll = pool.repo.replaceAll.bind(pool.repo)
  pool.repo.replaceAll = (list) => {
    saves++
    return replaceAll(list)
  }
  await manager.perform({ action: 'stop' })
  assert.equal(saves, 1)
  manager.syncPool()
  assert.equal(saves, 1)
})

test('simple rechecks and failed probe startup replace prior quality results', async (t) => {
  let mode = 'quality'
  const { manager } = fixture(t, {
    probeImpl: async () => {
      if (mode === 'error') throw new Error('probe failed')
      return {
        success: true,
        latency_ms: 1,
        ...(mode === 'quality' ? { quality: { passed: 3, total: 3 }, geo: { ip: '192.0.2.1' } } : {}),
      }
    },
  })
  const [id] = await exported(manager)
  await manager.test(id, true)
  mode = 'simple'
  await manager.test(id)
  assert.equal(manager.status().nodes[0].check.quality, undefined)
  mode = 'error'
  await assert.rejects(manager.test(id))
  assert.equal(manager.status().nodes[0].check.success, false)
  assert.equal(manager.status().nodes[0].check.geo, undefined)
})

test('Mihomo stop/start preserves manual pause and unrelated failure reasons', async (t) => {
  const { manager, pool, root } = fixture(t)
  fs.mkdirSync(path.join(root, 'vms'))
  for (const [id, reason] of [
    ['manual', 'manual'],
    ['quota', 'quota_exhausted'],
    ['healthy', null],
  ]) {
    fs.writeFileSync(
      path.join(root, 'vms', id + '.json'),
      JSON.stringify({ id, status: 'running', schedulable: !reason, schedule_disabled_reason: reason }),
    )
  }
  pool.onDisableVm = (id, reason, proxyId) => disableVmForProxy(root, id, reason, proxyId)
  pool.onEnableVm = (id, _reason, proxyId) => {
    if (getVm(root, id)?.schedule_disabled_reason?.includes('proxy=' + proxyId)) setVmSchedulable(root, id, true)
  }
  const [id] = await exported(manager)
  for (const slot of ['manual', 'quota', 'healthy']) pool.bind(managedProxyId(id), slot)
  await manager.perform({ action: 'stop' })
  await manager.perform({ action: 'start' })
  pool.probeOne = async () => ({ ok: true, latency_ms: 1 })
  await pool.probeById(managedProxyId(id))
  assert.equal(getVm(root, 'manual').schedulable, false)
  assert.equal(getVm(root, 'manual').schedule_disabled_reason, 'manual')
  assert.equal(getVm(root, 'quota').schedule_disabled_reason, 'quota_exhausted')
  assert.equal(getVm(root, 'healthy').schedulable, true)
  pool.probeOne = async () => ({ ok: false, error: 'timeout', latency_ms: 1 })
  await pool.probeById(managedProxyId(id))
  await pool.probeById(managedProxyId(id))
  pool.probeOne = async () => ({ ok: true, latency_ms: 1 })
  await pool.probeById(managedProxyId(id))
  assert.equal(getVm(root, 'manual').schedule_disabled_reason, 'manual')
  assert.equal(getVm(root, 'quota').schedule_disabled_reason, 'quota_exhausted')
})

test('subscription errors identify authentication and node index without exposing secrets', async (t) => {
  const { manager } = fixture(t)
  manager.fetch = async () => ({ ok: false, status: 403 })
  await assert.rejects(
    manager.perform({ action: 'source_add', url: 'https://example.com/?token=private' }),
    (error) => {
      assert.equal(error.code, 'subscription_http_failed')
      assert.match(error.message, /认证失败/)
      assert.doesNotMatch(error.message, /private|example.com/)
      return true
    },
  )
  manager.fetch = async () => ({
    ok: true,
    text: async () =>
      JSON.stringify({
        proxies: [
          { type: 'socks5', server: 'node.example', port: 1080 },
          { name: 'secret-name', type: 'socks5', server: 'node.example', port: 1080, 'private-key': '/secret-key' },
        ],
      }),
  })
  await assert.rejects(
    manager.perform({ action: 'source_add', url: 'https://example.com/?token=private' }),
    (error) => {
      assert.match(error.message, /第 2 个节点/)
      assert.doesNotMatch(error.message, /secret-name|secret-key|private|example.com/)
      return true
    },
  )
})

test('syncing a probe-disabled outlet preserves its pending slot recovery', async (t) => {
  let schedulable = true
  const { manager, pool } = fixture(t, {
    pool: {
      onDisableVm: () => {
        schedulable = false
      },
      onEnableVm: () => {
        schedulable = true
      },
    },
  })
  const [id] = await exported(manager)
  pool.bind(managedProxyId(id), 'slot-a')
  pool.probeOne = async () => ({ ok: false, error: 'timeout', latency_ms: 1 })
  await pool.probeById(managedProxyId(id))
  await pool.probeById(managedProxyId(id))
  assert.equal(schedulable, false)
  await manager.perform({ action: 'source_rename', id: manager.state.sources[0].id, label: 'renamed' })
  pool.probeOne = async () => ({ ok: true, latency_ms: 1 })
  await pool.probeById(managedProxyId(id))
  assert.equal(schedulable, true)
})
