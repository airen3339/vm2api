/**
 * E2E: panel VM test schedule CRUD, validation, and SQLite persistence.
 * The saved plan is disabled so this test never invokes a model.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'

test('panel VM test schedule validates, persists across restart, and deletes', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-test-schedule-e2e-'))
  let gw = await startGateway({ project })
  const endpoint = '/api/panel/vms/vm-sim-01/test-schedule'
  const plan = {
    enabled: false,
    cron: '0 9 * * *',
    timezone: 'UTC',
    model: 'claude-haiku-4-5-20251001',
    prompt: 'scheduled test e2e prompt',
    max_tokens: 64,
    reasoning_effort: null,
  }

  try {
    const initial = await api(gw, 'GET', endpoint)
    assert.equal(initial.status, 200, initial.text)
    assert.equal(initial.json.data.schedule, null)

    const saved = await api(gw, 'PUT', endpoint, { body: plan })
    assert.equal(saved.status, 200, saved.text)
    assert.deepEqual(Object.fromEntries(Object.keys(plan).map((key) => [key, saved.json.data.schedule[key]])), plan)
    assert.equal(saved.json.data.schedule.next_run_at, null)
    assert.equal(saved.json.data.schedule.running, false)

    const invalid = await api(gw, 'PUT', endpoint, {
      body: { ...plan, cron: '0 * * *' },
    })
    assert.equal(invalid.status, 400, invalid.text)
    assert.equal(invalid.json.error.code, 'invalid_test_schedule')

    const afterInvalid = await api(gw, 'GET', endpoint)
    assert.equal(afterInvalid.status, 200, afterInvalid.text)
    assert.deepEqual(
      Object.fromEntries(Object.keys(plan).map((key) => [key, afterInvalid.json.data.schedule[key]])),
      plan,
      'invalid cron must not overwrite the saved plan',
    )
  } finally {
    await gw.stop()
  }

  gw = await startGateway({ project })
  try {
    const restored = await api(gw, 'GET', endpoint)
    assert.equal(restored.status, 200, restored.text)
    assert.deepEqual(
      Object.fromEntries(Object.keys(plan).map((key) => [key, restored.json.data.schedule[key]])),
      plan,
      'disabled plan must survive a gateway restart',
    )

    const removed = await api(gw, 'DELETE', endpoint)
    assert.equal(removed.status, 200, removed.text)
    assert.equal(removed.json.data.schedule, null)

    const afterDelete = await api(gw, 'GET', endpoint)
    assert.equal(afterDelete.status, 200, afterDelete.text)
    assert.equal(afterDelete.json.data.schedule, null)
  } finally {
    await gw.stop()
  }
})
