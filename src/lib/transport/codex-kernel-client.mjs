/**
 * Codex kernel hop client. Same Unix-socket + internal token contract as
 * go-worker-client, socket is run/codex-kernel.sock.
 */
import path from 'node:path'
import {
  callGoWorker,
  isDownstreamCommitEvent,
  streamGoWorker,
  workerHealth,
  workerPaths,
} from './go-worker-client.mjs'

export function codexKernelPaths(exec = {}) {
  const base = workerPaths(exec)
  const runDir = base.runDir
  return {
    runDir,
    socketPath: exec.vm?.runtime?.codex_kernel_socket || (runDir ? path.join(runDir, 'codex-kernel.sock') : null),
    tokenPath: base.tokenPath,
    configPath: runDir ? path.join(runDir, 'codex-kernel.json') : null,
    credentialPath: runDir ? path.join(path.dirname(runDir), 'codex-credentials.json') : null,
  }
}

export function withCodexKernelExec(exec) {
  const paths = codexKernelPaths(exec)
  return {
    ...exec,
    vm: {
      ...(exec?.vm || {}),
      runtime: {
        ...(exec?.vm?.runtime || {}),
        worker_socket: paths.socketPath,
        worker_token_file: paths.tokenPath,
        worker_run_dir: paths.runDir,
      },
    },
  }
}

function remapVia(result) {
  if (!result || typeof result !== 'object') return result
  return {
    ...result,
    via: String(result.via || 'go-worker').replace(/go-worker/g, 'codex-kernel'),
  }
}

export async function callCodexKernel(opts = {}) {
  return remapVia(
    await callGoWorker({
      ...opts,
      exec: withCodexKernelExec(opts.exec),
      requestPath: '/internal/v1/codex/responses',
    }),
  )
}

const RESPONSES_TERMINAL = new Set(['response.completed', 'response.failed', 'response.incomplete'])

function codexStreamError(code, message) {
  return { type: 'error', error: { type: 'api_error', code, message } }
}

/**
 * Responses SSE is not an Anthropic message: it is complete only on
 * `response.completed`, and any terminal event reaches the client even with
 * no output before it. The kernel turns an upstream WebSocket close into a
 * clean end of stream, so that case is named here instead of passing as 200.
 */
export async function streamCodexKernel(opts = {}) {
  const startedAt = Date.now()
  let completed = null
  let terminal = null
  let failure = null
  let events = 0
  let lastEvent = null
  let lastEventAt = startedAt
  const result = await streamGoWorker({
    ...opts,
    exec: withCodexKernelExec(opts.exec),
    requestPath: '/internal/v1/codex/responses',
    onProtocolEvent(event) {
      events += 1
      lastEvent = String(event.type || '')
      lastEventAt = Date.now()
      if (terminal) return
      if (event.type === 'error') {
        terminal = 'error'
      } else if (RESPONSES_TERMINAL.has(event.type)) {
        const status = event.response?.status
        if (event.type === 'response.completed' && (!status || status === 'completed')) {
          completed = event.response && typeof event.response === 'object' ? event.response : {}
          terminal = 'completed'
        } else {
          terminal = event.type === 'response.completed' ? String(status) : event.type.slice('response.'.length)
          failure = event.response?.error || event.response?.incomplete_details || null
        }
      }
    },
    shouldCommitEvent: (event) => isDownstreamCommitEvent(event) || RESPONSES_TERMINAL.has(event?.type),
    isCompleteStream: () => !!completed,
  })
  const endedAt = Date.now()
  const streamDiagnostics = {
    events,
    last_event: lastEvent,
    terminal,
    committed: result?.committed === true,
    ms: endedAt - startedAt,
    idle_ms: endedAt - lastEventAt,
  }
  if (completed && Number(result?.status) === 200) {
    return remapVia({
      ...result,
      ok: true,
      body: completed,
      usage: completed.usage || result.usage,
      model: completed.model || result.model,
      terminalState: 'verified',
      streamDiagnostics,
    })
  }
  // Kernel HTTP errors, transport errors and streamed `error` events keep their own body.
  if (!result || result.ok || Number(result.status) !== 200 || result.transportError || terminal === 'error') {
    return remapVia(result && typeof result === 'object' ? { ...result, streamDiagnostics } : result)
  }
  if (terminal) {
    const code = String(failure?.code || failure?.reason || `response_${terminal}`)
    const message = String(failure?.message || `Codex response ended with status ${terminal}`)
    return remapVia({ ...result, ok: false, body: codexStreamError(code, message), streamDiagnostics })
  }
  const idleSec = Math.round(streamDiagnostics.idle_ms / 1000)
  const message =
    'upstream closed the Codex stream before response.completed ' +
    `(last event ${lastEvent || 'none'}, ${idleSec}s before close)`
  return remapVia({
    ...result,
    ok: false,
    // Nothing reached the client yet: a gateway status, never a 200, so the next slot can take it.
    status: result.committed ? result.status : 502,
    terminalState: 'incomplete',
    body: codexStreamError('codex_upstream', message),
    streamDiagnostics,
  })
}

export async function codexKernelHealth(exec, opts = {}) {
  const health = await workerHealth(withCodexKernelExec(exec), opts)
  if (health?.source) {
    return { ...health, source: String(health.source).replace(/go-worker/g, 'codex-kernel') }
  }
  return health
}
