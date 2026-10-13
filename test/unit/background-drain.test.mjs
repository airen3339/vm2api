import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises'
import { createHealthProbeMonitor } from '../../src/lib/admin/health-probe.mjs'
import { createCredentialRefreshMonitor } from '../../src/lib/oauth/credential-refresh-monitor.mjs'
import { createUsageProbeMonitor } from '../../src/lib/oauth/usage-probe-monitor.mjs'
import { ensureWorkerCredential, waitExistingCredentialRefreshes } from '../../src/lib/transport/go-worker-client.mjs'
import { createKernelWatchdog } from '../../src/lib/transport/kernel-watchdog.mjs'
import { createCliNodeGuard } from '../../src/lib/vm/cli-node-guard.mjs'
import { createNotifyMonitor } from '../../src/lib/admin/notify.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const VM = {
  id: 'vm-13',
  status: 'running',
  schedulable: true,
  has_token: true,
  has_refresh: true,
  expires_at: 1,
  proxy: { host: '127.0.0.1', port: 1080 },
}
const factories = [
  [
    'health probe',
    (operation) =>
      createHealthProbeMonitor({
        config: { enabled: true, run_on_start: true },
        listTargets: () => [VM],
        runChat: async () => {
          await operation()
          return { ok: true, text: 'ok', status: 200 }
        },
      }),
  ],
  [
    'credential refresh',
    (operation) =>
      createCredentialRefreshMonitor({
        config: { enabled: true, run_on_start: true },
        listTargets: () => [VM],
        refreshOne: async () => {
          await operation()
          return { ok: true }
        },
      }),
  ],
  [
    'usage probe',
    (operation) =>
      createUsageProbeMonitor({
        config: { enabled: true, run_on_start: true },
        listTargets: () => [VM],
        probeOne: async () => {
          await operation()
          return { ok: true }
        },
      }),
  ],
  [
    'notification',
    (operation) =>
      createNotifyMonitor({
        config: { enabled: true, run_on_start: true },
        snapshot: async () => {
          await operation()
          return { available: 1, total: 1, with_token: 1, accounts: [] }
        },
        send: async () => ({ ok: true }),
      }),
  ],
]

for (const [name, factory] of factories) {
  test(`${name}: whenIdle only observes existing work; stop cancels queued boot work and supports restart`, {
    timeout: 3000,
  }, async (t) => {
    const started = deferred()
    const finish = deferred()
    let calls = 0
    const monitor = factory(async () => {
      calls += 1
      started.resolve()
      await finish.promise
    })
    t.after(() => {
      monitor.stop()
      finish.resolve()
    })
    await monitor.whenIdle()
    assert.equal(calls, 0)
    monitor.start({ immediate: true })
    monitor.stop()
    monitor.stop()
    await nextTurn()
    assert.equal(calls, 0)
    monitor.setConfig(monitor.getConfig())
    await monitor.whenIdle()
    assert.equal(calls, 0)

    monitor.start({ immediate: true })
    await started.promise
    monitor.stop()
    let idle = false
    const waiting = monitor.whenIdle().then(() => {
      idle = true
    })
    await nextTurn()
    assert.equal(idle, false)
    assert.equal(calls, 1)
    finish.resolve()
    await waiting
    assert.equal(idle, true)
    assert.equal(calls, 1)
    await monitor.whenIdle()
    assert.equal(calls, 1)

    monitor.start({ immediate: true })
    await nextTurn()
    await monitor.whenIdle()
    assert.equal(calls, 2)
  })
}

test('watchdog whenIdle includes detached telemetry work after the main tick has finished', {
  timeout: 3000,
}, async (t) => {
  const started = deferred()
  const finish = deferred()
  let calls = 0
  const watchdog = createKernelWatchdog({
    listTargets: () => [{ ...VM, id: 'vm-sidecar-drain' }],
    ensureTelemetry: async () => {
      calls += 1
      started.resolve()
      await finish.promise
      return { ok: true }
    },
  })
  t.after(() => {
    watchdog.stop()
    finish.resolve()
  })
  await watchdog.whenIdle()
  assert.equal(calls, 0)
  await watchdog.tick()
  await started.promise
  watchdog.stop()
  let idle = false
  const waiting = watchdog.whenIdle().then(() => {
    idle = true
  })
  await nextTurn()
  assert.equal(idle, false)
  finish.resolve()
  await waiting
  assert.equal(idle, true)
  assert.equal(calls, 1)
})

test('watchdog whenIdle waits for an already admitted slot restart', { timeout: 3000 }, async (t) => {
  const started = deferred()
  const finish = deferred()
  let now = 0
  let calls = 0
  const id = 'vm-watchdog-drain'
  const watchdog = createKernelWatchdog({
    listTargets: () => [{ id, inference_engine: 'rust' }],
    now: () => now,
    health: async () => ({ ok: true, healthy: false, unhealthy_reason: 'fixture' }),
    ensure: async () => {
      calls += 1
      started.resolve()
      await finish.promise
      return { ok: true }
    },
  })
  t.after(() => {
    watchdog.stop()
    finish.resolve()
    kernelFaults.delete(id)
  })
  await watchdog.tick()
  assert.equal(calls, 0)
  now = 60_000
  const tick = watchdog.tick()
  await started.promise
  watchdog.stop()
  let idle = false
  const waiting = watchdog.whenIdle().then(() => {
    idle = true
  })
  await nextTurn()
  assert.equal(idle, false)
  finish.resolve()
  await tick
  await waiting
  assert.equal(idle, true)
  assert.equal(calls, 1)
})

test('CLI guard stop preserves an existing exec and whenIdle waits without launching another', {
  timeout: 3000,
}, async (t) => {
  const started = deferred()
  const finish = deferred()
  let calls = 0
  const guard = createCliNodeGuard({
    listTargets: () => [VM],
    exec: async () => {
      calls += 1
      started.resolve()
      await finish.promise
    },
  })
  t.after(() => {
    guard.stop()
    finish.resolve()
  })
  await guard.whenIdle()
  assert.equal(calls, 0)
  guard.start()
  await started.promise
  guard.stop()
  guard.stop()
  let idle = false
  const waiting = guard.whenIdle().then(() => {
    idle = true
  })
  await nextTurn()
  assert.equal(idle, false)
  finish.resolve()
  await waiting
  assert.equal(idle, true)
  assert.equal(calls, 1)
})

test('proxy whenIdle waits until an existing scheduled probe has saved its final database state', {
  timeout: 3000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-proxy-drain-'))
  const db = createDatabase({ dataDir: dir })
  const pool = new ProxyPool({ db })
  const started = deferred()
  const finish = deferred()
  let calls = 0
  pool.state.proxies = [{ id: 'px-drain', host: '127.0.0.1', port: 1080, enabled: true, status: 'ok', bound_vms: [] }]
  pool.probeOne = async () => {
    calls += 1
    started.resolve()
    await finish.promise
    return { ok: true, scope: 'socks', latency_ms: 1 }
  }
  t.after(async () => {
    pool.stopScheduler()
    finish.resolve()
    await pool.whenIdle()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await pool.whenIdle()
  assert.equal(calls, 0)
  pool.startScheduler()
  await started.promise
  pool.stopScheduler()
  let idle = false
  const waiting = pool.whenIdle().then(() => {
    idle = true
  })
  await nextTurn()
  assert.equal(idle, false)
  finish.resolve()
  await waiting
  assert.equal(idle, true)
  assert.equal(calls, 1)
  assert.equal(pool._probing, false)
  assert.ok(pool.repo.loadAll()[0].last_probe_at)
})

test('usage whenIdle includes event probes, queued probes and raw operations that outlive their timeout', {
  timeout: 3000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const starts = [deferred(), deferred()]
  const finishes = [deferred(), deferred()]
  let calls = 0
  const monitor = createUsageProbeMonitor({
    config: { concurrency: 1, timeout_ms: 10_000, run_on_start: false },
    listTargets: () => [VM, { ...VM, id: 'vm-14' }],
    probeOne: async (vm) => {
      const index = vm.id === VM.id ? 0 : 1
      calls += 1
      starts[index].resolve()
      await finishes[index].promise
      return { ok: true }
    },
  })
  t.after(() => {
    monitor.stop()
    for (const finish of finishes) finish.resolve()
  })
  const first = monitor.probeNow(VM.id)
  const duplicate = monitor.probeNow(VM.id)
  const queued = monitor.probeNow('vm-14')
  assert.equal(first, duplicate)
  await starts[0].promise
  monitor.stop()
  let idle = false
  const waiting = monitor.whenIdle().then(() => {
    idle = true
  })
  t.mock.timers.tick(10_000)
  assert.equal((await first).error, 'probe_timeout')
  await starts[1].promise
  t.mock.timers.tick(10_000)
  assert.equal((await queued).error, 'probe_timeout')
  await nextTurn()
  assert.equal(calls, 2)
  assert.equal(idle, false)
  finishes[0].resolve()
  await nextTurn()
  assert.equal(idle, false)
  finishes[1].resolve()
  await waiting
  assert.equal(idle, true)
  assert.equal(calls, 2)
})

test('host refresh drain waits for the existing serialized tail and never initiates an extra refresh', {
  timeout: 5000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-refresh-drain-'))
  const homeDir = path.join(dir, 'home')
  const docker = path.join(dir, 'fake-docker')
  const countFile = path.join(dir, 'calls')
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
  fs.writeFileSync(
    path.join(homeDir, '.claude', 'credentials.json'),
    JSON.stringify({
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      expires_at: 1,
    }),
  )
  fs.writeFileSync(
    docker,
    `#!${process.execPath}\n` +
      `const fs = require('node:fs'); const path = require('node:path');\n` +
      `const dir = ${JSON.stringify(dir)}; const countFile = path.join(dir, 'calls');\n` +
      `const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) + 1 : 1;\n` +
      `fs.writeFileSync(countFile, String(count)); fs.writeFileSync(path.join(dir, 'started-' + count), '1');\n` +
      `const timer = setInterval(() => { if (!fs.existsSync(path.join(dir, 'release-' + count))) return;\n` +
      `clearInterval(timer); process.stdout.write(JSON.stringify({ok:true,status:200,body:{refreshed:false}}) + '\\n'); }, 5);\n`,
    { mode: 0o700 },
  )
  const priorDocker = process.env.KIN_DOCKER_BIN
  const priorMock = process.env.KIN_CRS_MOCK
  process.env.KIN_DOCKER_BIN = docker
  process.env.KIN_CRS_MOCK = '0'
  const refreshes = []
  t.after(async () => {
    fs.writeFileSync(path.join(dir, 'release-1'), '1')
    fs.writeFileSync(path.join(dir, 'release-2'), '1')
    await Promise.allSettled(refreshes)
    if (priorDocker === undefined) delete process.env.KIN_DOCKER_BIN
    else process.env.KIN_DOCKER_BIN = priorDocker
    if (priorMock === undefined) delete process.env.KIN_CRS_MOCK
    else process.env.KIN_CRS_MOCK = priorMock
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const waitStarted = async (number) => {
    while (!fs.existsSync(path.join(dir, `started-${number}`))) await delay(5)
  }
  await waitExistingCredentialRefreshes()
  assert.equal(fs.existsSync(countFile), false)
  const exec = { vmId: 'vm-13', vm: { id: 'vm-13' }, homeDir }
  refreshes.push(ensureWorkerCredential(exec, { force: true }))
  refreshes.push(ensureWorkerCredential(exec, { force: true }))
  await waitStarted(1)
  let idle = false
  const waiting = waitExistingCredentialRefreshes().then(() => {
    idle = true
  })
  await nextTurn()
  assert.equal(idle, false)
  fs.writeFileSync(path.join(dir, 'release-1'), '1')
  await waitStarted(2)
  assert.equal(idle, false)
  fs.writeFileSync(path.join(dir, 'release-2'), '1')
  const results = await Promise.all(refreshes)
  await waiting
  assert.equal(idle, true)
  assert.equal(
    results.every((result) => result.ok),
    true,
  )
  await waitExistingCredentialRefreshes()
  assert.equal(Number(fs.readFileSync(countFile, 'utf8')), 2)
})
