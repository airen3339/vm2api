import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import childProcess from 'node:child_process'
import { once } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { MihomoRuntime, atomicJson, availablePort } from '../../src/lib/mihomo/runtime.mjs'

const core = `
  import fs from 'node:fs'
  import net from 'node:net'
  import http from 'node:http'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
  const config = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'))
  for (const listener of config.listeners)
    net.createServer().listen(listener.port, listener.listen)
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/version') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ version: 'v1.20.1' }))
    } else {
      request.resume()
      request.on('end', () => response.writeHead(204).end())
    }
  })
  server.listen(Number(config['external-controller'].split(':').at(-1)), '127.0.0.1')
`

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-mihomo-runtime-'))
  const runtime = new MihomoRuntime({ dir, binary: process.execPath })
  const children = []
  const spawn = childProcess.spawn
  t.mock.method(childProcess, 'spawn', (binary, args, options) => {
    assert.equal(binary, process.execPath)
    assert.deepEqual(args.slice(0, 3), ['-d', dir, '-f'])
    const child = spawn(process.execPath, ['--input-type=module', '-e', core, args[3]], options)
    children.push({ child, kill: child.kill.bind(child) })
    return child
  })
  syncBuiltinESMExports()
  runtime.validate = async () => {}
  t.after(async () => {
    for (const { child, kill } of children) {
      if (child.exitCode != null || child.signalCode != null) continue
      const closed = once(child, 'close')
      kill('SIGKILL')
      await closed
    }
    t.mock.restoreAll()
    syncBuiltinESMExports()
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('vm2api-mihomo-runtime-'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { runtime, dir, children }
}

const config = (port) => ({
  listeners: port ? [{ name: 'fixed-node', type: 'socks', listen: '127.0.0.1', port, proxy: 'REJECT' }] : [],
  rules: ['MATCH,REJECT'],
})

test('stop cancels startup while validation is still pending without spawning a core', async (t) => {
  const { runtime, children } = fixture(t)
  const validation = Promise.withResolvers()
  runtime.validate = () => validation.promise
  const starting = runtime.start(config())
  const rejected = assert.rejects(starting, { code: 'kernel_start_failed' })
  const stopping = runtime.stop()
  validation.resolve()
  await Promise.all([rejected, stopping])
  assert.equal(children.length, 0)
  assert.equal(runtime.running, false)
})

test('stop cancels real configuration validation and waits for candidate cleanup', async (t) => {
  const { runtime, dir, children } = fixture(t)
  runtime.validate = MihomoRuntime.prototype.validate
  const kill = childProcess.ChildProcess.prototype.kill
  let validator, closed
  t.mock.method(childProcess.ChildProcess.prototype, 'kill', function (signal) {
    validator = this
    closed = new Promise((resolve) => this.once('close', resolve))
    return kill.call(this, signal)
  })
  t.after(async () => {
    await closed
  })
  const starting = runtime.start(config())
  const rejected = assert.rejects(starting, { code: 'kernel_start_failed' })
  await runtime.stop()
  await rejected
  assert.equal(runtime.starting, null)
  assert.ok(validator.exitCode != null || validator.signalCode != null)
  assert.equal(children.length, 0)
  assert.equal(fs.existsSync(path.join(dir, 'candidate.json')), false)
})

test('stop during controller readiness cannot report successful startup', async (t) => {
  const { runtime } = fixture(t)
  const applied = Promise.withResolvers()
  const release = Promise.withResolvers()
  const request = runtime.request.bind(runtime)
  runtime.request = async (...args) => {
    const response = await request(...args)
    if (args[0] === 'PUT') {
      applied.resolve()
      await release.promise
    }
    return response
  }
  const starting = runtime.start(config())
  await applied.promise
  const rejected = assert.rejects(starting, { code: 'kernel_start_failed' })
  const stopping = runtime.stop()
  release.resolve()
  await Promise.all([rejected, stopping])
  assert.equal(runtime.running, false)
})

test('concurrent stops both await real process exit and release its fixed listener', async (t) => {
  const { runtime } = fixture(t)
  const port = await availablePort()
  let exits = 0
  runtime.onExit = () => exits++
  await runtime.start(config(port))
  const child = runtime.child
  const kill = child.kill.bind(child)
  t.mock.method(child, 'kill', (signal = 'SIGTERM') => {
    setTimeout(() => kill(signal), 100)
    return true
  })
  const first = runtime.stop()
  let exitedAtSecondReturn
  const second = runtime.stop().then(() => {
    exitedAtSecondReturn = child.exitCode != null || child.signalCode != null
  })
  await Promise.all([first, second])
  assert.equal(exitedAtSecondReturn, true)
  assert.equal(runtime.child, null)
  assert.equal(exits, 0, 'intentional shutdown must not report an unexpected exit')
  assert.equal(await availablePort(port), port)
})

test('forced shutdown awaits the actual exit after SIGKILL', { timeout: 10000 }, async (t) => {
  const { runtime } = fixture(t)
  await runtime.start(config())
  const child = runtime.child
  const kill = child.kill.bind(child)
  const signals = []
  t.mock.method(child, 'kill', (signal = 'SIGTERM') => {
    signals.push(signal)
    if (signal === 'SIGKILL') setTimeout(() => kill(signal), 100)
    return true
  })
  const stopping = runtime.stop()
  await assert.rejects(runtime.install(), { code: 'kernel_running' })
  await assert.rejects(runtime.start(config()), { code: 'kernel_running' })
  await stopping
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.ok(child.exitCode != null || child.signalCode != null)
})

test('unexpected core exit still notifies the owner exactly once', async (t) => {
  const { runtime } = fixture(t)
  let exits = 0
  runtime.onExit = () => exits++
  await runtime.start(config())
  const child = runtime.child
  const closed = once(child, 'close')
  child.kill('SIGKILL')
  await closed
  assert.equal(runtime.running, false)
  assert.equal(exits, 1)
  await runtime.stop()
})

test('an occupied fixed listener rejects startup without replacing its port or spawning', async (t) => {
  const { runtime, children } = fixture(t)
  const server = net.createServer()
  t.after(() => new Promise((resolve) => server.close(resolve)))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await assert.rejects(runtime.start(config(port)), { code: 'port_in_use' })
  assert.equal(children.length, 0)
  assert.equal(server.address().port, port)
})

test('failed atomic replacement removes its temporary file without removing the destination', (t) => {
  const { dir } = fixture(t)
  const destination = path.join(dir, 'settings.json')
  fs.mkdirSync(destination)
  assert.throws(() => atomicJson(destination, { listeners: [] }))
  assert.equal(fs.statSync(destination).isDirectory(), true)
  assert.equal(fs.existsSync(destination + '.tmp'), false)
})

test('a non-Mihomo version response clears stale installed-version information', async (t) => {
  const { runtime } = fixture(t)
  runtime.version = 'v1.20.1'
  await assert.rejects(runtime.detectVersion(), { code: 'kernel_version_failed' })
  assert.equal(runtime.version, null)
})

test('controller errors close unfinished HTTP responses instead of retaining sockets', async (t) => {
  const { runtime } = fixture(t)
  let socket
  const server = http.createServer((_request, response) => {
    response.writeHead(503)
    response.write('unfinished response')
  })
  server.on('connection', (connection) => {
    socket = connection
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  runtime.port = server.address().port
  await assert.rejects(runtime.request('GET', '/version'), { code: 'kernel_control_failed' })
  if (!socket.destroyed) await once(socket, 'close', { signal: AbortSignal.timeout(1000) })
  assert.equal(socket.destroyed, true)
})

test('external startup cancellation prevents spawning after validation', async (t) => {
  const { runtime, children } = fixture(t)
  const abort = new AbortController()
  const validation = Promise.withResolvers()
  runtime.validate = () => validation.promise
  const starting = runtime.start(config(), { signal: abort.signal })
  const rejected = assert.rejects(starting, { code: 'kernel_start_failed' })
  abort.abort()
  validation.resolve()
  await rejected
  assert.equal(children.length, 0)
  assert.equal(runtime.running, false)
})

test('cancelling installation during binary validation keeps the old kernel and removes candidates', {
  skip: process.platform !== 'linux',
  timeout: 15000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-mihomo-install-cancel-'))
  const bytes = gzipSync(
    Buffer.from(`#!/usr/bin/env node
if (process.argv.includes('-v')) console.log('Mihomo Meta v1.20.1 linux amd64')
else setInterval(() => {}, 1000)
`),
  )
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64-compatible'
  const release = {
    tag_name: 'v1.20.1',
    assets: [
      {
        name: `mihomo-linux-${arch}-v1.20.1.gz`,
        size: bytes.length,
        digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  }
  const runtime = new MihomoRuntime({
    dir,
    fetchImpl: async (url) =>
      url.endsWith('/releases/latest')
        ? { ok: true, json: async () => release }
        : { ok: true, body: Readable.from([bytes]) },
  })
  t.after(async () => {
    await runtime.stop()
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('vm2api-mihomo-install-cancel-'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  fs.writeFileSync(runtime.binary, 'previous kernel', { mode: 0o700 })
  runtime.version = 'v1.19.31'
  const entered = Promise.withResolvers()
  const validate = runtime.validate.bind(runtime)
  runtime.validate = (...args) => {
    const result = validate(...args)
    entered.resolve()
    return result
  }
  const abort = new AbortController()
  const installing = runtime.install({ config: config(), signal: abort.signal })
  const rejected = assert.rejects(installing, { code: 'kernel_operation_cancelled' })
  await entered.promise
  abort.abort()
  await rejected
  assert.equal(fs.readFileSync(runtime.binary, 'utf8'), 'previous kernel')
  assert.equal(runtime.version, 'v1.19.31')
  assert.equal(fs.existsSync(runtime.binary + '.download'), false)
  assert.equal(fs.existsSync(path.join(dir, 'candidate.json')), false)
})
