import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import {
  normalizeVmTestSchedule,
  VM_TEST_SCHEDULE_PREFIX,
  VmTestScheduleRunner,
} from '../../src/lib/admin/vm-test-schedule.mjs'

class MemorySettings {
  values = new Map()

  get(key, fallback = null) {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : fallback
  }

  set(key, value) {
    this.values.set(key, structuredClone(value))
    return value
  }

  remove(key) {
    this.values.delete(key)
  }

  all() {
    return Object.fromEntries([...this.values].map(([key, value]) => [key, structuredClone(value)]))
  }
}

const claudeVm = { id: 'vm-01', platform: 'anthropic' }
const claudeConfig = {
  enabled: true,
  cron: '0 9 * * *',
  timezone: 'America/Los_Angeles',
  model: 'claude-haiku-4-5',
  prompt: 'hello',
  max_tokens: 64,
  reasoning_effort: null,
}

function runner({
  settings = new MemorySettings(),
  list = () => [claudeVm],
  runTest = async () => ({ ok: true }),
} = {}) {
  return {
    settings,
    schedule: new VmTestScheduleRunner({
      projectRoot: '/missing-project',
      settings: () => settings,
      list,
      runTest,
      now: () => Date.parse('2026-10-16T00:00:00.000Z'),
    }),
  }
}

test('schedule validation requires five-field cron, a named timezone, and platform parameters', () => {
  const normalized = normalizeVmTestSchedule({ ...claudeConfig, enabled: undefined }, claudeVm)
  assert.equal(normalized.enabled, false)
  assert.equal(normalized.timezone, 'America/Los_Angeles')
  assert.throws(() => normalizeVmTestSchedule({ ...claudeConfig, cron: '0 0 9 * * *' }, claudeVm), /five-field/)
  assert.throws(() => normalizeVmTestSchedule({ ...claudeConfig, timezone: '+08:00' }, claudeVm), /IANA timezone/)
  assert.throws(() => normalizeVmTestSchedule({ ...claudeConfig, cron: '60 9 * * *' }, claudeVm), /invalid cron/)

  const codexVm = { id: 'vm-02', platform: 'openai' }
  assert.equal(
    normalizeVmTestSchedule({ ...claudeConfig, max_tokens: undefined, reasoning_effort: 'medium' }, codexVm)
      .reasoning_effort,
    'medium',
  )
  assert.throws(() => normalizeVmTestSchedule({ ...claudeConfig, max_tokens: undefined }, codexVm), /reasoning_effort/)
})

test('SettingsRepo schedules reload after restart without an immediate catch-up run', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-test-schedule-'))
  const dbPath = path.join(dataDir, 'settings.db')
  let db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)')
  let settings = new SettingsRepo(db)
  let first
  let restored
  t.after(() => {
    first?.stop()
    restored?.stop()
    db.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  let runs = 0
  first = runner({
    settings,
    runTest: async () => {
      runs += 1
      return { ok: true }
    },
  }).schedule
  first.save('vm-01', claudeConfig)
  assert.deepEqual(
    Object.keys(settings.all()).filter((key) => key.startsWith(VM_TEST_SCHEDULE_PREFIX)),
    [`${VM_TEST_SCHEDULE_PREFIX}vm-01`],
  )
  first.start()
  assert.equal(first.jobs.has('vm-01'), true)
  assert.equal(first.get('vm-01').running, false)
  assert.ok(first.get('vm-01').next_run_at)
  first.stop()

  db.close()
  db = new DatabaseSync(dbPath)
  settings = new SettingsRepo(db)
  restored = new VmTestScheduleRunner({
    projectRoot: '/missing-project',
    settings: () => settings,
    list: () => [claudeVm],
    runTest: async () => {
      runs += 1
      return { ok: true }
    },
  })
  restored.start()
  assert.equal(restored.jobs.has('vm-01'), true)
  assert.equal(runs, 0)
  assert.equal(restored.get('vm-01').enabled, true)
  restored.stop()
})

test('runs do not overlap per VM and failures persist only compact result fields', async () => {
  let releaseRun
  let calls = 0
  const { settings, schedule } = runner({
    runTest: () => {
      calls += 1
      return new Promise((resolve) => {
        releaseRun = resolve
      })
    },
  })
  schedule.save('vm-01', claudeConfig)
  schedule.start()

  const job = schedule.jobs.get('vm-01')
  const first = job.trigger()
  const second = job.trigger()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.equal(schedule.get('vm-01').running, true)

  releaseRun({
    ok: false,
    duration_ms: 27,
    error: { code: 'upstream_timeout', message: 'timeout '.repeat(80) },
    text: 'response content must not be stored',
    log: ['verbose diagnostic log must not be stored'],
    body: { content: 'response content must not be stored' },
  })
  await Promise.all([first, second])

  const stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(stored.last_ok, false)
  assert.equal(stored.last_duration_ms, 27)
  assert.equal(stored.last_run_at, '2026-10-16T00:00:00.000Z')
  assert.ok(stored.last_error.length <= 300)
  assert.equal('text' in stored, false)
  assert.equal('log' in stored, false)
  assert.equal('body' in stored, false)
  assert.equal(JSON.stringify(stored).includes('response content must not be stored'), false)
  assert.equal(JSON.stringify(stored).includes('verbose diagnostic log'), false)
  schedule.stop()
})

test('an in-flight run cannot write results to a deleted and recreated plan', async () => {
  let releaseRun
  const { settings, schedule } = runner({
    runTest: () =>
      new Promise((resolve) => {
        releaseRun = resolve
      }),
  })
  schedule.save('vm-01', claudeConfig)
  schedule.start()
  const oldRevision = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`).revision
  const oldRun = schedule.jobs.get('vm-01').trigger()
  await new Promise((resolve) => setImmediate(resolve))

  schedule.remove('vm-01')
  schedule.save('vm-01', claudeConfig)
  const newPlan = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.notEqual(newPlan.revision, oldRevision)
  releaseRun({ ok: true, duration_ms: 10, text: 'completed response must not attach to the new plan' })
  await oldRun

  const stored = settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`)
  assert.equal(stored.last_run_at, null)
  assert.equal(stored.last_ok, null)
  assert.equal(stored.prompt, claudeConfig.prompt)
  schedule.stop()
})

test('reload and delete stop orphaned VM plans', () => {
  let vms = [claudeVm]
  const { settings, schedule } = runner({ list: () => vms })
  schedule.save('vm-01', claudeConfig)
  schedule.start()
  assert.equal(schedule.jobs.has('vm-01'), true)

  vms = []
  schedule.reload()
  assert.equal(schedule.jobs.has('vm-01'), false)
  assert.equal(settings.get(`${VM_TEST_SCHEDULE_PREFIX}vm-01`), null)
  assert.equal(schedule.remove('vm-01'), null)
  schedule.stop()
})
