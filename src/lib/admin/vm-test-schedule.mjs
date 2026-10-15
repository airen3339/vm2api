import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { validTimezone } from '../core/timezone.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { getVm, listVms } from '../vm/vm-registry.mjs'

export const VM_TEST_SCHEDULE_PREFIX = 'vm_test_schedule:'

const MAX_CRON_LENGTH = 120
const MAX_MODEL_LENGTH = 200
const MAX_PROMPT_LENGTH = 16_000
const MAX_ERROR_LENGTH = 300
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])

export class VmTestScheduleError extends Error {
  constructor(message, code = 'invalid_test_schedule', status = 400) {
    super(message)
    this.name = 'VmTestScheduleError'
    this.code = code
    this.status = status
  }
}

function keyFor(vmId) {
  return `${VM_TEST_SCHEDULE_PREFIX}${vmId}`
}

function assertCron(cron, timezone) {
  if (cron.length > MAX_CRON_LENGTH || cron.trim().split(/\s+/).length !== 5) {
    throw new VmTestScheduleError('cron must be a five-field expression')
  }
  let validator
  try {
    validator = new Cron(cron, { timezone, mode: '5-part', paused: true })
    if (!validator.nextRun()) throw new Error('no upcoming run')
  } catch (error) {
    throw new VmTestScheduleError(`invalid cron: ${String(error?.message || error).slice(0, 180)}`)
  } finally {
    validator?.stop()
  }
}

export function normalizeVmTestSchedule(input, vm) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new VmTestScheduleError('request body must be an object')
  }

  const enabled = input.enabled == null ? false : input.enabled
  if (typeof enabled !== 'boolean') throw new VmTestScheduleError('enabled must be a boolean')

  const cron = String(input.cron || '').trim()
  if (!cron) throw new VmTestScheduleError('cron is required')
  const timezone = validTimezone(input.timezone)
  if (!timezone) throw new VmTestScheduleError('timezone must be a valid IANA timezone')
  assertCron(cron, timezone)

  const model = String(input.model || '').trim()
  if (!model || model.length > MAX_MODEL_LENGTH) {
    throw new VmTestScheduleError('model is required and must be at most 200 characters')
  }
  const prompt = String(input.prompt ?? '').trim()
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
    throw new VmTestScheduleError('prompt is required and must be at most 16000 characters')
  }

  let maxTokens = input.max_tokens == null ? null : input.max_tokens
  if (maxTokens != null && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 128_000)) {
    throw new VmTestScheduleError('max_tokens must be an integer from 1 to 128000')
  }

  let reasoningEffort = input.reasoning_effort == null ? null : String(input.reasoning_effort).trim()
  if (reasoningEffort === '') reasoningEffort = null
  if (reasoningEffort != null && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new VmTestScheduleError('reasoning_effort must be none, low, medium, high, xhigh, or max')
  }
  if (isCodexVm(vm)) {
    if (maxTokens != null || reasoningEffort == null) {
      throw new VmTestScheduleError('Codex schedules require reasoning_effort and omit max_tokens')
    }
  } else if (maxTokens == null || reasoningEffort != null) {
    throw new VmTestScheduleError('Claude schedules require max_tokens and omit reasoning_effort')
  }

  return { enabled, cron, timezone, model, prompt, max_tokens: maxTokens, reasoning_effort: reasoningEffort }
}

function compactError(error) {
  const code = String(error?.code || 'test_failed')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 64)
  const message = String(error?.message || 'scheduled test failed')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
  return `${code}: ${message}`.slice(0, MAX_ERROR_LENGTH)
}

function nullableIso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function savedResult(raw = {}) {
  return {
    last_run_at: nullableIso(raw.last_run_at),
    last_ok: typeof raw.last_ok === 'boolean' ? raw.last_ok : null,
    last_duration_ms:
      Number.isSafeInteger(raw.last_duration_ms) && raw.last_duration_ms >= 0 ? raw.last_duration_ms : null,
    last_error:
      raw.last_error == null
        ? null
        : String(raw.last_error)
            .replace(/[\r\n\t]/g, ' ')
            .slice(0, MAX_ERROR_LENGTH),
  }
}

export class VmTestScheduleRunner {
  constructor({
    projectRoot,
    settings = () => null,
    runTest,
    list = () => listVms(projectRoot),
    now = () => Date.now(),
  } = {}) {
    this.projectRoot = projectRoot
    this.settingsFactory = typeof settings === 'function' ? settings : () => settings
    this.runTest = runTest
    this.listVms = list
    this.now = now
    this.jobs = new Map()
    this.running = new Set()
    this.started = false
  }

  _settings() {
    const settings = this.settingsFactory()
    if (!settings || typeof settings.get !== 'function' || typeof settings.set !== 'function') {
      throw new Error('VM test schedule settings store is unavailable')
    }
    return settings
  }

  _vm(vmId) {
    return this.listVms().find((vm) => vm.id === vmId) || getVm(this.projectRoot, vmId)
  }

  _stored(vmId) {
    const raw = this._settings().get(keyFor(vmId))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const vm = this._vm(vmId)
    if (!vm) return null
    try {
      return {
        ...normalizeVmTestSchedule(raw, vm),
        ...savedResult(raw),
        revision: String(raw.revision || ''),
      }
    } catch {
      return null
    }
  }

  _nextRun(schedule, job = this.jobs.get(schedule.vm_id)) {
    if (!schedule.enabled) return null
    let next = null
    try {
      next = job?.nextRun?.() || null
      if (!job) {
        const probe = new Cron(schedule.cron, {
          timezone: schedule.timezone,
          mode: '5-part',
          paused: true,
        })
        next = probe.nextRun()
        probe.stop()
      }
    } catch {}
    return next instanceof Date && Number.isFinite(next.getTime()) ? next.toISOString() : null
  }

  _public(vmId, schedule) {
    if (!schedule) return null
    return {
      enabled: schedule.enabled,
      cron: schedule.cron,
      timezone: schedule.timezone,
      model: schedule.model,
      prompt: schedule.prompt,
      max_tokens: schedule.max_tokens,
      reasoning_effort: schedule.reasoning_effort,
      last_run_at: schedule.last_run_at,
      last_ok: schedule.last_ok,
      last_duration_ms: schedule.last_duration_ms,
      last_error: schedule.last_error,
      next_run_at: this._nextRun({ ...schedule, vm_id: vmId }),
      running: this.running.has(vmId),
    }
  }

  get(vmId) {
    return this._public(vmId, this._stored(vmId))
  }

  save(vmId, input) {
    if (!isValidVmId(vmId)) throw new VmTestScheduleError('invalid vm id', 'invalid_vm_id')
    const vm = this._vm(vmId)
    if (!vm) throw new VmTestScheduleError('vm not found', 'vm_not_found', 404)
    const previous = this._settings().get(keyFor(vmId)) || {}
    const config = normalizeVmTestSchedule(input, vm)
    this._settings().set(keyFor(vmId), { ...config, ...savedResult(previous), revision: randomUUID() })
    if (this.started) this._syncJob(vmId, config)
    return this.get(vmId)
  }

  remove(vmId) {
    this.jobs.get(vmId)?.stop()
    this.jobs.delete(vmId)
    this._settings().remove?.(keyFor(vmId))
    return null
  }

  start() {
    this.started = true
    this.reload()
  }

  stop() {
    this.started = false
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
  }

  reload() {
    for (const job of this.jobs.values()) job.stop()
    this.jobs.clear()
    const all = this._settings().all?.() || {}
    for (const key of Object.keys(all)) {
      if (!key.startsWith(VM_TEST_SCHEDULE_PREFIX)) continue
      const vmId = key.slice(VM_TEST_SCHEDULE_PREFIX.length)
      const vm = this._vm(vmId)
      if (!vm) {
        this._settings().remove?.(key)
        continue
      }
      const schedule = this._stored(vmId)
      if (schedule?.enabled) this._syncJob(vmId, schedule)
    }
  }

  _syncJob(vmId, schedule) {
    this.jobs.get(vmId)?.stop()
    this.jobs.delete(vmId)
    if (!this.started || !schedule.enabled || !this._vm(vmId)) return
    const job = new Cron(schedule.cron, { timezone: schedule.timezone, mode: '5-part', catch: true, unref: true }, () =>
      this._run(vmId),
    )
    this.jobs.set(vmId, job)
  }

  async _run(vmId) {
    if (!this.started || this.running.has(vmId)) return
    if (!this._vm(vmId)) {
      this.remove(vmId)
      return
    }
    const schedule = this._stored(vmId)
    if (!schedule?.enabled) return
    this.running.add(vmId)
    const startedAt = this.now()
    let result
    try {
      result = await this.runTest(vmId, {
        model: schedule.model,
        prompt: schedule.prompt,
        max_tokens: schedule.max_tokens,
        reasoning_effort: schedule.reasoning_effort,
      })
    } catch (error) {
      result = { ok: false, error }
    } finally {
      this.running.delete(vmId)
    }
    if (!this.started) return

    const current = this._settings().get(keyFor(vmId))
    if (!current || String(current.revision || '') !== schedule.revision || !this._vm(vmId)) return
    const duration = Number(result?.duration_ms)
    const lastDuration =
      Number.isSafeInteger(duration) && duration >= 0 ? duration : Math.max(0, this.now() - startedAt)
    const lastOk = result?.ok === true
    this._settings().set(keyFor(vmId), {
      ...current,
      last_run_at: new Date(startedAt).toISOString(),
      last_ok: lastOk,
      last_duration_ms: lastDuration,
      last_error: lastOk ? null : compactError(result?.error),
    })
  }
}
