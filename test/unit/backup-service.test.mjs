import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { openDatabase, closeDatabase, getDb, vacuumInto } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { BackupService, tarAvailable } from '../../src/lib/admin/backup-service.mjs'
import { MihomoManager, managedProxyId } from '../../src/lib/mihomo/manager.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { stopVmWatch, initVmDbSync } from '../../src/lib/vm/vm-db-sync.mjs'
import { setVmWriteHook } from '../../src/lib/vm/vm-file.mjs'

let root, dataDir, configDir, svc

function seedVm(id = 'vm-b1') {
  const vmsDir = path.join(root, 'vms')
  fs.mkdirSync(vmsDir, { recursive: true })
  fs.writeFileSync(
    path.join(vmsDir, `${id}.json`),
    JSON.stringify(
      {
        id,
        name: 'b',
        status: 'running',
        claude: { access_token: 'sk-ant-oat01-BAK', refresh_token: 'sk-ant-ort01-BAK', account_uuid: 'acct-b' },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(vmsDir, 'active.json'), JSON.stringify({ active_vm: id }))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bak-'))
  dataDir = path.join(root, 'data')
  configDir = path.join(root, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, 'routing.json'), JSON.stringify({ sticky: { enabled: true } }))
  openDatabase({ dataDir })
  svc = new BackupService({ dataDir, projectRoot: root, configDir })
})

afterEach(() => {
  svc.stopScheduler()
  stopVmWatch()
  setVmWriteHook(null)
  closeDatabase()
  fs.rmSync(root, { recursive: true, force: true })
  delete process.env.KIN_BACKUP_DISABLED
  delete process.env.KIN_BACKUP_INTERVAL_HOURS
  delete process.env.KIN_BACKUP_RETENTION
})

test('tar is available in this environment', () => {
  assert.equal(tarAvailable(), true)
})

test('createBackup produces tar.gz with manifest + db + vms + config, records ok', () => {
  seedVm()
  initVmDbSync(root, { watch: false })
  new SettingsRepo(getDb()).set('marker', 'before-backup')

  const rec = svc.createBackup({ kind: 'manual' })
  assert.equal(rec.status, 'ok')
  assert.equal(rec.kind, 'manual')
  assert.ok(rec.file_path.endsWith('.tar.gz'))
  assert.ok(fs.existsSync(rec.file_path))
  assert.ok(rec.size_bytes > 0)
  assert.match(rec.sha256, /^[0-9a-f]{64}$/)
  assert.equal(rec.includes.vms, 2) // vm-b1.json + active.json
  assert.equal(rec.includes.config, 1)

  // archive contents sane
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-bak-x-'))
  spawnSync('tar', ['-xzf', rec.file_path, '-C', tmp])
  assert.ok(fs.existsSync(path.join(tmp, 'manifest.json')))
  assert.ok(fs.existsSync(path.join(tmp, 'db', 'kin.db')))
  assert.ok(fs.existsSync(path.join(tmp, 'vms', 'vm-b1.json')))
  assert.ok(fs.existsSync(path.join(tmp, 'config', 'routing.json')))
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'))
  assert.equal(manifest.version, 1)
  assert.ok(manifest.sha256s['db/kin.db'])
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('restoreBackup rolls data back and creates pre_restore record', async () => {
  seedVm()
  initVmDbSync(root, { watch: false })
  const keys = new ApiKeyStore({ db: getDb() })
  const kept = keys.create({ name: 'kept-key' })

  const rec = svc.createBackup({ kind: 'manual' })

  // mutate after the backup
  const lost = keys.create({ name: 'lost-key' })
  new SettingsRepo(getDb()).set('marker', 'after-backup')
  // wire the rebind like the server does
  let reboundDb = null
  svc.onRestored((db) => {
    reboundDb = db
    keys.rebind(db)
  })

  const out = await svc.restoreBackup(rec.id)
  assert.equal(out.ok, true)
  assert.ok(reboundDb, 'rebind callback should fire')

  // state rolled back
  assert.ok(keys.getById(kept.id), 'pre-backup key survives')
  assert.equal(keys.getById(lost.id), null, 'post-backup key rolled back')
  assert.equal(new SettingsRepo(getDb()).get('marker'), null)

  // old db file kept on disk as safety net
  assert.ok(fs.existsSync(path.join(dataDir, 'kin.db.pre-restore')))
  // pre_restore archive file kept on disk for manual recovery
  const preFiles = fs.readdirSync(path.join(dataDir, 'backups'))
  assert.ok(preFiles.length >= 2, 'manual + pre_restore archives on disk')
  // ledger re-registered after restore: pre_restore (and restored manual) visible
  const ledger = svc.list()
  assert.ok(
    ledger.some((r) => r.id === out.pre_restore && r.kind === 'pre_restore'),
    'pre_restore record re-registered in restored DB',
  )
  assert.ok(
    ledger.some((r) => r.id === rec.id),
    'restored manual record present',
  )
  assert.ok(
    ledger.every((r) => r.file_exists),
    'all ledger rows point at real files',
  )
})

test('restore fails when stores cannot rebind to the reopened database', async () => {
  seedVm()
  const rec = svc.createBackup({ kind: 'manual' })
  svc.onRestored(() => {
    throw new Error('store rebind failed')
  })

  await assert.rejects(() => svc.restoreBackup(rec.id), /store rebind failed/)
  assert.equal(svc.isRestoring, false)
  assert.doesNotThrow(() => getDb().prepare('SELECT 1').get())
})

test('restore rebuilds vm files from DB mirror for db-only path', async () => {
  seedVm('vm-b2')
  initVmDbSync(root, { watch: false })
  const rec = svc.createBackup({ kind: 'manual' })

  // delete vm file + its row is still in backup db; also delete local file post-backup
  fs.rmSync(path.join(root, 'vms', 'vm-b2.json'))
  const out = await svc.restoreBackup(rec.id)
  assert.equal(out.ok, true)
  const back = JSON.parse(fs.readFileSync(path.join(root, 'vms', 'vm-b2.json'), 'utf8'))
  // tar snapshot still has the on-disk file from backup time; DB is metadata only.
  assert.equal(back.claude.access_token, 'sk-ant-oat01-BAK')
  const row = new VmsRepo(getDb()).get('vm-b2')
  assert.equal(row.access_token, null)
  assert.equal(row.vm.claude.has_access, true)
  assert.equal(row.vm.claude.access_token, undefined)
})

test('sha256 tamper detection blocks restore', async () => {
  seedVm()
  const rec = svc.createBackup({ kind: 'manual' })
  fs.appendFileSync(rec.file_path, 'tamper')
  await assert.rejects(() => svc.restoreBackup(rec.id), /sha256 mismatch/)
})

test('retention prunes old backups', () => {
  process.env.KIN_BACKUP_RETENTION = '2'
  seedVm()
  const recs = []
  for (let i = 0; i < 4; i++) recs.push(svc.createBackup({ kind: 'manual' }))
  const remaining = svc.list().filter((r) => r.kind === 'manual')
  assert.equal(remaining.length, 2)
  // newest two kept
  assert.ok(remaining.some((r) => r.id === recs[3].id))
  assert.ok(remaining.some((r) => r.id === recs[2].id))
  // pruned files removed from disk
  assert.equal(fs.existsSync(recs[0].file_path), false)
  assert.equal(fs.existsSync(recs[1].file_path), false)
})

test('schedule config defaults on, env override off, updateSchedule persists', () => {
  const cfg = svc.getSchedule()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.interval_hours, 24)
  assert.equal(cfg.retention, 7)

  svc.updateSchedule({ interval_hours: 6, retention: 3 })
  assert.equal(svc.getSchedule().interval_hours, 6)
  assert.equal(svc.getSchedule().retention, 3)
  assert.throws(() => svc.updateSchedule({ interval_hours: 0 }), /interval_hours/)

  process.env.KIN_BACKUP_DISABLED = '1'
  assert.equal(svc.getSchedule().enabled, false)
})

test('shouldRunScheduled: true when never run, false right after a backup', () => {
  seedVm()
  assert.equal(svc.shouldRunScheduled(), true)
  svc.createBackup({ kind: 'scheduled' })
  assert.equal(svc.shouldRunScheduled(), false)
  // pretend 25h elapsed
  assert.equal(svc.shouldRunScheduled(Date.now() + 25 * 3600_000), true)
})

test('remove deletes record + file', () => {
  seedVm()
  const rec = svc.createBackup({ kind: 'manual' })
  assert.equal(svc.remove(rec.id), true)
  assert.equal(fs.existsSync(rec.file_path), false)
  assert.equal(svc.get(rec.id), null)
})

function managedBackup(t) {
  const pool = new ProxyPool({ db: getDb() })
  const runtime = {
    installed: true,
    running: false,
    async start(config) {
      this.running = true
      this.config = config
    },
    async stop() {
      this.running = false
    },
    async apply(config) {
      this.config = config
    },
  }
  const manager = new MihomoManager({ dataDir, proxyPool: pool, runtime })
  svc.mihomo = manager
  svc.onRestored((db) => pool.rebind(db))
  t.after(async () => {
    await manager.close()
    pool.stopScheduler()
  })
  return { manager, pool, runtime }
}

test('restore replaces live Mihomo settings, listeners, pool and cached checks together', async (t) => {
  const { manager, pool, runtime } = managedBackup(t)
  await manager.perform({ action: 'dynamic_add', text: 'http://first.example:8000#first' })
  await manager.perform({ action: 'start' })
  const id = manager.status().nodes[0].id
  await manager.perform({ action: 'node_export', id })
  pool.bind(managedProxyId(id), 'slot-before')
  const binding = structuredClone(manager.state.bindings[id])
  const rec = svc.createBackup()
  await manager.perform({ action: 'dynamic_add', text: 'http://second.example:8000#second' })
  await manager.perform({ action: 'stop' })
  manager.checks.set(id, { success: false })
  assert.equal((await svc.restoreBackup(rec.id)).ok, true)
  assert.equal(manager.status().sources.length, 1)
  assert.equal(runtime.running, true)
  assert.deepEqual(manager.state.bindings[id], binding)
  assert.equal(runtime.config.listeners.find((l) => l.name === id).port, binding.port)
  assert.equal(manager.checks.size, 0)
  assert.deepEqual(pool.snapshot().proxies[0].bound_vm_ids, ['slot-before'])
  assert.equal(new SettingsRepo(getDb()).has('backup_mihomo_state'), false)
})

test('db-only gzip fallback also restores Mihomo state', async (t) => {
  const { manager, runtime } = managedBackup(t)
  await manager.perform({ action: 'dynamic_add', text: 'http://first.example:8000' })
  const oldPath = process.env.PATH
  let rec
  try {
    process.env.PATH = ''
    rec = svc.createBackup()
  } finally {
    process.env.PATH = oldPath
  }
  assert.ok(rec.file_name.endsWith('.db.gz'))
  await manager.perform({ action: 'start' })
  await manager.perform({ action: 'source_rename', id: manager.state.sources[0].id, label: 'changed' })
  await svc.restoreBackup(rec.id)
  assert.equal(runtime.running, false)
  assert.notEqual(manager.state.sources[0].label, 'changed')
})

test('restoring a backup without Mihomo removes post-backup sources and outlets', async (t) => {
  const { manager, pool, runtime } = managedBackup(t)
  const rec = svc.createBackup()
  await manager.perform({ action: 'dynamic_add', text: 'http://later.example:8000' })
  await manager.perform({ action: 'start' })
  await manager.perform({ action: 'node_export', id: manager.status().nodes[0].id })
  await svc.restoreBackup(rec.id)
  assert.equal(manager.state.sources.length, 0)
  assert.equal(pool.snapshot().proxies.length, 0)
  assert.equal(runtime.running, false)
})

test('backup restoration rejects active management and waits for active checks', async (t) => {
  const { manager } = managedBackup(t)
  await manager.perform({ action: 'dynamic_add', text: 'http://first.example:8000' })
  const rec = svc.createBackup()
  let release
  const work = manager.exclusive(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  await assert.rejects(svc.restoreBackup(rec.id), { code: 'busy' })
  release()
  await work
  let finish
  manager.probeImpl = () =>
    new Promise((resolve) => {
      finish = resolve
    })
  const check = manager.test(manager.status().nodes[0].id)
  const restoring = svc.restoreBackup(rec.id)
  assert.equal(svc.isRestoring, true)
  await assert.rejects(manager.test(manager.status().nodes[0].id), { code: 'busy' })
  finish({ success: true, latency_ms: 1 })
  await check
  await restoring
  assert.equal(svc.isRestoring, false)
  assert.equal(manager.checks.size, 0)
})

test('legacy backups containing managed proxies without Mihomo settings are rejected before stopping', async (t) => {
  const { manager, runtime } = managedBackup(t)
  await manager.perform({ action: 'dynamic_add', text: 'http://first.example:8000' })
  await manager.perform({ action: 'start' })
  await manager.perform({ action: 'node_export', id: manager.status().nodes[0].id })
  const rec = svc.createBackup()
  const snapshot = path.join(root, 'legacy.db')
  vacuumInto(getDb(), snapshot)
  const archive = path.join(root, 'legacy.db.gz')
  fs.writeFileSync(archive, zlib.gzipSync(fs.readFileSync(snapshot)))
  const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  getDb()
    .prepare('UPDATE backup_records SET file_path=?, file_name=?, sha256=? WHERE id=?')
    .run(archive, 'legacy.db.gz', hash, rec.id)
  await assert.rejects(svc.restoreBackup(rec.id), { code: 'backup_mihomo_missing' })
  assert.equal(runtime.running, true)
})

test('Mihomo file checksum is verified before restoring state', async (t) => {
  const { manager, runtime } = managedBackup(t)
  await manager.perform({ action: 'dynamic_add', text: 'http://first.example:8000' })
  await manager.perform({ action: 'start' })
  const rec = svc.createBackup()
  const unpacked = path.join(root, 'unpacked')
  fs.mkdirSync(unpacked)
  assert.equal(spawnSync('tar', ['-xzf', rec.file_path, '-C', unpacked]).status, 0)
  fs.appendFileSync(path.join(unpacked, 'mihomo', 'settings.json'), ' ')
  assert.equal(spawnSync('tar', ['-czf', rec.file_path, '-C', unpacked, '.']).status, 0)
  const hash = createHash('sha256').update(fs.readFileSync(rec.file_path)).digest('hex')
  getDb().prepare('UPDATE backup_records SET sha256=? WHERE id=?').run(hash, rec.id)
  await assert.rejects(svc.restoreBackup(rec.id), { code: 'backup_corrupt' })
  assert.equal(runtime.running, true)
})
