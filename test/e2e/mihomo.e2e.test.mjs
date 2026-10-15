import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import nodeFetch from 'node-fetch'
import { MihomoManager, managedProxyId } from '../../src/lib/mihomo/manager.mjs'
import { kernelConfig, parseSubscription, localProxyUrl } from '../../src/lib/mihomo/config.mjs'
import { createProxyAgent } from '../../src/lib/vm/proxy-agent.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

async function outlet(name) {
  let requests = 0
  const sockets = new Set()
  const server = http.createServer((_req, res) => {
    requests++
    res.end(name)
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.once('data', (data) => {
      if (data.toString().includes('/hold')) {
        socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nX\r\n')
        return
      }
      requests++
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${name.length}\r\nConnection: close\r\n\r\n${name}`)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    requests: () => requests,
    close: () => {
      for (const s of sockets) s.destroy()
      server.close()
    },
  }
}
async function through(binding) {
  const agent = createProxyAgent(localProxyUrl(binding))
  try {
    const res = await nodeFetch('http://192.0.2.1/', { agent, signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error(`status:${res.status}`)
    return res.text()
  } finally {
    agent.destroy()
  }
}

test('official Mihomo: independent exits, reload, fail-closed removal, stable bindings after restart', {
  skip: !process.env.KIN_MIHOMO_TEST_BIN && process.env.KIN_MIHOMO_INSTALL_SMOKE !== '1',
  timeout: 180000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-mihomo-live-'))
  const a = await outlet('A'),
    b = await outlet('B')
  const pool = new ProxyPool({ dataDir: dir })
  const manager = new MihomoManager({ dataDir: dir, proxyPool: pool, binary: process.env.KIN_MIHOMO_TEST_BIN })
  t.after(async () => {
    await manager.close()
    pool.db.close()
    a.close()
    b.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  if (!manager.runtime.installed) {
    await manager.perform({ action: 'install' })
    assert.equal(manager.status().running, true, 'installation automatically starts the real kernel')
    assert.match(manager.status().version, /^v\d+\.\d+\.\d+$/)
    assert.equal(manager.status().install_progress.stage, 'complete')
    assert.ok(manager.status().install_progress.downloaded_bytes > 0)
    await manager.perform({ action: 'stop' })
  } else await manager.runtime.detectVersion()
  for (const version of ['dual', 'ipv4', 'ipv6', 'ipv4-prefer', 'ipv6-prefer']) {
    const nodes = parseSubscription(
      JSON.stringify({ proxies: [{ type: 'http', server: 'localhost', port: a.port, 'ip-version': version }] }),
    )
    await manager.runtime.validate(kernelConfig({ sources: [{ nodes, enabled: true }], disabled: [], bindings: {} }))
  }
  await manager.perform({ action: 'dynamic_add', text: `http://127.0.0.1:${a.port}#A\nhttp://127.0.0.1:${b.port}#B` })
  const [idA, idB] = manager.status().nodes.map((n) => n.id)
  let confirmedApplies = 0
  const controlRequest = manager.runtime.request.bind(manager.runtime)
  manager.runtime.request = async (method, route, body) => {
    const result = await controlRequest(method, route, body)
    if (method === 'PUT' && route === '/configs?force=true') confirmedApplies++
    return result
  }
  await manager.perform({ action: 'start' })
  assert.equal(confirmedApplies, 1, 'startup must wait for configuration and listeners, not just /version')
  await manager.perform({ action: 'node_export', ids: [idA, idB] })
  const first = structuredClone(manager.state.bindings)
  assert.equal(await through(first[idA]), 'A')
  assert.equal(await through(first[idB]), 'B')
  assert.deepEqual(await Promise.all([through(first[idA]), through(first[idB]), through(first[idA])]), ['A', 'B', 'A'])
  const agentA = createProxyAgent(localProxyUrl(first[idA]))
  const agentB = createProxyAgent(localProxyUrl(first[idB]))
  const streamA = await nodeFetch('http://192.0.2.1/hold', { agent: agentA, signal: AbortSignal.timeout(15000) })
  const streamB = await nodeFetch('http://192.0.2.1/hold', { agent: agentB, signal: AbortSignal.timeout(15000) })
  let closedA = false,
    closedB = false
  streamA.body.on('error', () => {
    closedA = true
  })
  streamB.body.on('error', () => {
    closedB = true
  })
  streamA.body.resume()
  streamB.body.resume()
  await manager.perform({ action: 'node_disable', id: idA })
  for (let i = 0; i < 30 && !closedA; i++) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(closedA, true, 'disabled node must close existing streams')
  assert.equal(closedB, false, 'unrelated node stream must survive')
  agentA.destroy()
  agentB.destroy()

  await assert.rejects(through(first[idA]))
  assert.equal(await through(first[idB]), 'B')
  await manager.perform({ action: 'node_enable', id: idA })
  assert.equal(await through(first[idA]), 'A')
  await manager.perform({ action: 'stop' })
  await assert.rejects(through(first[idB]))
  await manager.perform({ action: 'start' })
  assert.equal(await through(first[idB]), 'B')
  await manager.close()
  const restored = new MihomoManager({ dataDir: dir, proxyPool: pool, binary: process.env.KIN_MIHOMO_TEST_BIN })
  t.after(() => restored.close())
  await restored.restore()
  assert.equal(restored.runtime.running, true, restored.error)
  assert.deepEqual(restored.state.bindings, first)
  assert.equal(await through(first[idA]), 'A')
  await restored.perform({ action: 'source_remove', id: restored.state.sources[0].id })
  assert.equal(pool.snapshot().proxies.find((p) => p.id === managedProxyId(idA)).enabled, false)
  await assert.rejects(through(first[idA]))
  await assert.rejects(through(first[idB]))
  assert.ok(a.requests() >= 4)
  assert.ok(b.requests() >= 4)
  await restored.close()
})
