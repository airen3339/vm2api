import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createGracefulShutdown } from '../../src/lib/http/graceful-shutdown.mjs'

const IDLE = { claudeInFlight: 0, claudeWaiters: 0, codexInFlight: 0, codexWaiters: 0 }
function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t, handle, options = {}) {
  let controller
  const server = http.createServer(async (req, res) => {
    const release = controller.admitRequest(req, res)
    if (!release) return
    try {
      await handle(req, res)
    } finally {
      release()
    }
  })
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  controller = createGracefulShutdown({
    server,
    readPoolState: () => IDLE,
    finalize: () => {},
    pollIntervalMs: 2,
    ...options,
  })
  t.after(
    () =>
      new Promise((resolve) => {
        // Cleanup only: the shutdown controller never destroys executing sockets.
        for (const socket of sockets) socket.destroy()
        http.Server.prototype.close.call(server, () => resolve())
      }),
  )
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, controller, port: server.address().port }
}

function request(port, { method = 'GET', path = '/', onResponse = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false }, (res) => {
      let text = ''
      onResponse(res)
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        text += chunk
      })
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function socketRequest(t, port) {
  const socket = net.connect({ host: '127.0.0.1', port })
  t.after(() => socket.destroy())
  await once(socket, 'connect')
  let output = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    output += chunk
  })
  const ended = once(socket, 'end').then(() => output)
  return { socket, ended }
}

test('shutdown preserves a real SSE terminal, post-response logging, pool waiters and background work', {
  timeout: 3000,
}, async (t) => {
  const started = deferred()
  const finishStream = deferred()
  const finishLogging = deferred()
  const poolRead = deferred()
  const backgroundStarted = deferred()
  const finishBackground = deferred()
  const pool = { ...IDLE, claudeInFlight: 1, codexWaiters: 1 }
  let logged = false
  let finalizations = 0
  let schedulerStops = 0
  const { controller, port } = await fixture(
    t,
    async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n')
      started.resolve()
      await finishStream.promise
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      await finishLogging.promise
      logged = true
    },
    {
      stopBackground: () => {
        schedulerStops += 1
      },
      readPoolState: () => {
        poolRead.resolve()
        return pool
      },
      waitBackground: () => {
        backgroundStarted.resolve()
        return finishBackground.promise
      },
      finalize: () => {
        finalizations += 1
      },
    },
  )
  t.after(() => {
    finishStream.resolve()
    finishLogging.resolve()
    finishBackground.resolve()
    Object.assign(pool, IDLE)
  })
  const response = request(port)
  await started.promise
  const shutdown = controller.shutdown('SIGTERM')
  assert.equal(controller.draining, true)
  assert.equal(controller.shutdown('SIGINT'), shutdown)
  await nextTurn()
  assert.equal(schedulerStops, 1)
  assert.equal(finalizations, 0)

  finishStream.resolve()
  const received = await response
  assert.equal(received.status, 200)
  assert.match(received.text, /event: message_stop\ndata: \{"type":"message_stop"\}/)
  assert.equal(finalizations, 0)
  pool.claudeInFlight = 0
  finishLogging.resolve()
  await poolRead.promise
  assert.equal(logged, true)
  assert.equal(finalizations, 0)
  pool.codexWaiters = 0
  await backgroundStarted.promise
  assert.equal(finalizations, 0)
  finishBackground.resolve()
  await shutdown
  assert.equal(finalizations, 1)
  await controller.shutdown('SIGTERM')
  assert.equal(finalizations, 1)
})

test('every HTTP method/path and new upgrades are rejected before handlers while close is pending', {
  timeout: 3000,
}, async (t) => {
  let handlers = 0
  let upgrades = 0
  let finalized = false
  const closeStarted = deferred()
  const { server, controller, port } = await fixture(
    t,
    (_req, res) => {
      handlers += 1
      res.end('unexpected')
    },
    {
      finalize: () => {
        finalized = true
      },
    },
  )
  server.on('upgrade', (req, socket) => {
    if (!controller.admitUpgrade(req, socket)) return
    upgrades += 1
    socket.end()
  })
  let closeCallback
  server.close = (callback) => {
    closeCallback = callback
    closeStarted.resolve()
    return server
  }
  const shutdown = controller.shutdown('SIGTERM')
  await closeStarted.promise
  for (const [method, path] of [
    ['OPTIONS', '/v1/messages'],
    ['GET', '/healthz'],
    ['GET', '/console'],
    ['PUT', '/api/panel/routing'],
    ['POST', '/v1/messages'],
    ['POST', '/v1/responses'],
  ]) {
    const rejected = await request(port, { method, path })
    assert.equal(rejected.status, 503)
    assert.equal(rejected.headers.connection, 'close')
    assert.equal(JSON.parse(rejected.text).error.code, 'gateway_draining')
  }
  const { socket, ended } = await socketRequest(t, port)
  socket.write('GET /shell HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
  assert.match(await ended, /^HTTP\/1\.1 503 Service Unavailable/)
  assert.equal(handlers, 0)
  assert.equal(upgrades, 0)
  assert.equal(finalized, false)
  http.Server.prototype.close.call(server, closeCallback)
  await shutdown
  assert.equal(finalized, true)
})

test('a pipelined request on an executing keep-alive connection cannot enter after real server.close', {
  timeout: 3000,
}, async (t) => {
  const started = deferred()
  const finishResponse = deferred()
  const rejected = deferred()
  let handlers = 0
  const { controller, port } = await fixture(t, async (_req, res) => {
    handlers += 1
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: first\n\n')
    started.resolve()
    await finishResponse.promise
    res.end('event: message_stop\ndata: terminal\n\n')
  })
  t.after(() => finishResponse.resolve())
  const originalAdmit = controller.admitRequest
  controller.admitRequest = (...args) => {
    const admitted = originalAdmit(...args)
    if (!admitted) rejected.resolve()
    return admitted
  }
  const { socket, ended } = await socketRequest(t, port)
  socket.write('GET /stream HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n')
  await started.promise
  const shutdown = controller.shutdown('SIGTERM')
  await nextTurn()
  socket.write('OPTIONS /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n')
  await rejected.promise
  assert.equal(handlers, 1)
  finishResponse.resolve()
  const received = await ended
  assert.match(received, /event: message_stop/)
  assert.match(received, /HTTP\/1\.1 503 Service Unavailable/)
  assert.match(received, /gateway_draining/)
  await shutdown
})

test('pending, invalid and failed pool reads cannot finalize; every busy counter must reach zero', {
  timeout: 3000,
}, async (t) => {
  const firstRead = deferred()
  const delayedState = deferred()
  const readError = deferred()
  const busyRead = deferred()
  let reads = 0
  let finalized = false
  let canIdle = false
  const failures = []
  const { controller } = await fixture(t, (_req, res) => res.end(), {
    readPoolState: () => {
      reads += 1
      if (reads === 1) {
        firstRead.resolve()
        return delayedState.promise
      }
      if (reads === 2) throw new Error('temporary state read failure')
      busyRead.resolve()
      return canIdle ? IDLE : { ...IDLE, claudeWaiters: 1, codexInFlight: 1 }
    },
    onError: (error) => {
      failures.push(error.message)
      if (failures.length === 2) readError.resolve()
    },
    finalize: () => {
      finalized = true
    },
  })
  t.after(() => {
    canIdle = true
    delayedState.resolve(IDLE)
  })
  const shutdown = controller.shutdown('SIGTERM')
  await firstRead.promise
  await nextTurn()
  assert.equal(finalized, false)
  delayedState.resolve({ claudeInFlight: 0 })
  await readError.promise
  assert.equal(finalized, false)
  assert.match(failures[0], /unavailable or invalid/)
  assert.equal(failures[1], 'temporary state read failure')
  await busyRead.promise
  assert.equal(finalized, false)
  canIdle = true
  await shutdown
  assert.equal(finalized, true)
})

test('an accepted upgrade must close naturally before finalization while pool and background barriers run', {
  timeout: 3000,
}, async (t) => {
  const upgraded = deferred()
  const backgroundObserved = deferred()
  let acceptedSocket
  let socketClosed = false
  let finalized = false
  const { server, controller, port } = await fixture(t, (_req, res) => res.end(), {
    waitBackground: () => backgroundObserved.resolve(),
    finalize: () => {
      finalized = true
    },
  })
  server.on('upgrade', (req, socket) => {
    if (!controller.admitUpgrade(req, socket)) return
    acceptedSocket = socket
    socket.once('close', () => {
      socketClosed = true
    })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n')
    upgraded.resolve()
  })
  const { socket, ended } = await socketRequest(t, port)
  socket.write('GET /shell HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n')
  await upgraded.promise
  const shutdown = controller.shutdown('SIGTERM')
  await backgroundObserved.promise
  await nextTurn()
  assert.equal(socketClosed, false)
  assert.equal(finalized, false)
  // This is the existing peer/session closing, not a shutdown timeout.
  const closed = once(acceptedSocket, 'close')
  acceptedSocket.end()
  await ended
  await closed
  await shutdown
  assert.equal(socketClosed, true)
  assert.equal(finalized, true)
})

test('an unsuccessful server.close retains the process and repeated signals share the failed drain', async () => {
  const closeError = new Error('listener close failed')
  let finalized = false
  const controller = createGracefulShutdown({
    server: { close: (callback) => callback(closeError) },
    readPoolState: () => IDLE,
    finalize: () => {
      finalized = true
    },
  })
  const shutdown = controller.shutdown('SIGTERM')
  await assert.rejects(shutdown, closeError)
  assert.equal(controller.shutdown('SIGINT'), shutdown)
  assert.equal(controller.draining, true)
  assert.equal(finalized, false)
})
