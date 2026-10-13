import { setTimeout as delay } from 'node:timers/promises'
import { corsHeaders } from './respond.mjs'

const POOL_COUNTERS = ['claudeInFlight', 'claudeWaiters', 'codexInFlight', 'codexWaiters']
const DRAINING_BODY = JSON.stringify({
  error: {
    type: 'overloaded_error',
    code: 'gateway_draining',
    message: 'Gateway is shutting down; retry on a healthy gateway.',
  },
})

function poolsAreIdle(state) {
  if (!state || POOL_COUNTERS.some((key) => !Number.isSafeInteger(state[key]) || state[key] < 0)) {
    throw new Error('Shutdown pool state is unavailable or invalid')
  }
  return POOL_COUNTERS.every((key) => state[key] === 0)
}

/**
 * HTTP handlers and responses have separate lifetimes: a handler can return
 * before a file stream finishes, or write the response before its log cleanup.
 * Existing upgraded control/shell sockets must close naturally before the
 * server.close barrier completes. No active socket is destroyed on a timer.
 */
export function createGracefulShutdown({
  server,
  readPoolState,
  stopBackground = () => {},
  waitBackground = () => {},
  finalize,
  onError = () => {},
  pollIntervalMs = 100,
} = {}) {
  if (!server || typeof readPoolState !== 'function' || typeof finalize !== 'function') {
    throw new TypeError('Graceful shutdown needs a server, pool state reader and finalizer')
  }
  let draining = false
  let shutdownPromise = null
  let activeHandlers = 0
  let activeResponses = 0
  let closeFailure = null

  const admitRequest = (_req, res) => {
    if (draining) {
      res.writeHead(
        503,
        corsHeaders({
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(DRAINING_BODY),
          connection: 'close',
        }),
      )
      res.end(DRAINING_BODY)
      return null
    }
    activeHandlers += 1
    activeResponses += 1
    let responseFinished = false
    const releaseResponse = () => {
      if (responseFinished) return
      responseFinished = true
      activeResponses -= 1
      res.off('finish', releaseResponse)
      res.off('close', releaseResponse)
    }
    res.once('finish', releaseResponse)
    res.once('close', releaseResponse)
    let handlerFinished = false
    return () => {
      if (handlerFinished) return
      handlerFinished = true
      activeHandlers -= 1
    }
  }

  const admitUpgrade = (_req, socket) => {
    if (!draining) return true
    socket.end(
      'HTTP/1.1 503 Service Unavailable\r\n' +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${Buffer.byteLength(DRAINING_BODY)}\r\n` +
        'Connection: close\r\n\r\n' +
        DRAINING_BODY,
    )
    return false
  }

  const waitForHttpAndPools = async () => {
    for (;;) {
      if (closeFailure) throw closeFailure
      if (activeHandlers === 0 && activeResponses === 0) {
        try {
          const idle = poolsAreIdle(await readPoolState())
          if (idle && activeHandlers === 0 && activeResponses === 0) return
        } catch (error) {
          // A failed or unfinished state read is never evidence of zero work.
          try {
            onError(error)
          } catch {}
        }
      }
      await delay(pollIntervalMs)
    }
  }

  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise
    // Close admission in the signal's own tick, before any async work.
    draining = true
    shutdownPromise = Promise.resolve().then(async () => {
      await stopBackground(signal)
      const closed = new Promise((resolve, reject) => {
        const completed = (error) => {
          if (error) {
            closeFailure = error
            reject(error)
          } else resolve()
        }
        try {
          server.close(completed)
        } catch (error) {
          completed(error)
        }
      })
      // Do not wait for long-lived upgrades before observing admitted HTTP and
      // background work. Finalization still requires every barrier to complete.
      await Promise.all([
        closed,
        (async () => {
          await waitForHttpAndPools()
          await waitBackground()
        })(),
      ])
      await finalize(signal)
    })
    return shutdownPromise
  }

  return {
    admitRequest,
    admitUpgrade,
    shutdown,
    get draining() {
      return draining
    },
  }
}
