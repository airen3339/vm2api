import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import nodeFetch from 'node-fetch'
import { parseSubscription, parseDynamic, collectNodes, kernelConfig, fault } from '../../src/lib/mihomo/config.mjs'
import { MihomoManager, managedProxyId, checkExit } from '../../src/lib/mihomo/manager.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

const subscription = (server = 'one.example', name = '节点一') =>
  JSON.stringify({
    proxies: [{ name, type: 'socks5', server, port: 1080, username: 'user', password: 'secret-node' }],
    listeners: [{ port: 80 }],
    rules: ['MATCH,DIRECT'],
  })
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-mihomo-'))
  const runtime = {
    installed: true,
    version: 'v1.19.31',
    running: false,
    configs: [],
    rejected: [],
    async start(c) {
      this.running = true
      this.configs.push(c)
    },
    async stop() {
      this.running = false
    },
    async apply(c, reject = []) {
      if (this.fail) throw fault('kernel_failed', 'failed', 502)
      this.configs.push(c)
      this.rejected = reject
    },
    async install({ version, onProgress }) {
      this.installVersion = version
      onProgress({ stage: 'downloading', version: 'v1.19.32', downloaded_bytes: 4, total_bytes: 8 })
      this.installed = true
      this.version = version === 'latest' ? 'v1.19.32' : version
    },
    async checkUpdate() {
      this.latestVersion = 'v1.19.32'
    },
  }
  const pool = new ProxyPool({ dataDir: dir, canUseManagedProxy: (id) => id !== 'remote' })
  const fetches = []
  const manager = new MihomoManager({
    dataDir: dir,
    proxyPool: pool,
    runtime,
    fetchImpl: async (url, opts) => {
      fetches.push({ url, opts })
      return { ok: true, text: async () => subscription() }
    },
    ...options,
  })
  t.after(async () => {
    await manager.close()
    pool.stopScheduler()
    pool.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { manager, pool, runtime, dir, fetches }
}
const add = (manager, url = 'https://source.example/?token=secret-url') =>
  manager.perform({ action: 'source_add', url })

test('only outbound nodes are imported; identity excludes name but includes credentials', () => {
  const a = parseSubscription(subscription())[0]
  const b = parseSubscription(subscription('one.example', '改名'))[0]
  assert.equal(a.id, b.id)
  assert.equal(a.config.name, undefined)
  assert.throws(() => parseSubscription('proxies: []'))
  assert.throws(() => parseSubscription('proxies: [{type: direct, name: bypass}]'))
  assert.throws(() => parseSubscription('proxies: [{type: socks5, server: abc, port: 1080, dialer-proxy: DIRECT}]'))
  assert.throws(() => parseSubscription('proxies: [{type: socks5, server: abc, port: 1080, private-key: /secret}]'))
  assert.throws(() => parseSubscription('proxies: [{type: socks5, server: abc, port: 0}]'))
  assert.equal(parseDynamic('socks5://user:pass@127.0.0.1:1234#节点\nhttps://user:pass@host:443')[1].config.tls, true)
  assert.throws(() => parseDynamic('file:///secret'))
})

test('Mihomo API is admin-only for reads and writes', () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    assert.equal(authorizePanelRoute(method, '/api/panel/mihomo', 'admin').ok, true)
    for (const role of ['user', 'super']) assert.equal(authorizePanelRoute(method, '/api/panel/mihomo', role).ok, false)
  }
})

test('source secrets never appear in status; downloaded top-level configuration is ignored', async (t) => {
  const { manager } = fixture(t)
  await add(manager)
  assert.doesNotMatch(JSON.stringify(manager.status()), /secret-url|secret-node|one\.example/)
  const config = kernelConfig(manager.state)
  assert.deepEqual(config.rules, ['MATCH,REJECT'])
  assert.equal(config.listeners.length, 0)
})

test('shared nodes survive source removal; deleting last source rejects fixed listener', async (t) => {
  const { manager, runtime } = fixture(t)
  await add(manager)
  await add(manager, 'https://two.example')
  const id = manager.status().nodes[0].id
  assert.equal(manager.status().nodes.length, 1)
  await manager.perform({ action: 'start' })
  await manager.perform({ action: 'node_export', ids: [id] })
  await manager.perform({ action: 'source_remove', id: manager.status().sources[0].id })
  assert.equal(manager.status().nodes.length, 1)
  await manager.perform({ action: 'source_remove', id: manager.status().sources[0].id })
  assert.equal(manager.status().nodes.length, 0)
  assert.equal(runtime.configs.at(-1).listeners.find((l) => l.name === id).proxy, 'REJECT')
  assert.ok(runtime.rejected.includes(id))
})

test('failed refresh/apply preserve previous cached sources and settings', async (t) => {
  const { manager, runtime } = fixture(t)
  await add(manager)
  const before = fs.readFileSync(manager.file, 'utf8')
  manager.fetch = async () => {
    throw new Error('secret-url')
  }
  await assert.rejects(manager.perform({ action: 'source_refresh', id: manager.state.sources[0].id }), /原节点保留/)
  assert.equal(fs.readFileSync(manager.file, 'utf8'), before)
  runtime.fail = true
  await assert.rejects(manager.perform({ action: 'source_disable', id: manager.state.sources[0].id }))
  assert.equal(fs.readFileSync(manager.file, 'utf8'), before)
  assert.equal(manager.state.sources[0].enabled, true)
})

test('proxy-only download never falls back; direct ignores running proxy; auto falls back on bad YAML', async (t) => {
  const { manager, fetches } = fixture(t)
  await manager.perform({ action: 'download_mode', mode: 'proxy' })
  await assert.rejects(add(manager), /不会回退直连/)
  assert.equal(fetches.length, 0)
  await manager.perform({ action: 'start' })
  manager.fetch = async (_url, opts) => {
    fetches.push(opts)
    return { ok: true, text: async () => (opts.agent ? '<html>error</html>' : subscription()) }
  }
  await assert.rejects(add(manager))
  assert.equal(fetches.length, 1)
  await manager.perform({ action: 'download_mode', mode: 'auto' })
  await add(manager)
  assert.equal(fetches.length, 3)
  assert.ok(fetches[1].agent)
  assert.equal(fetches[2].agent, undefined)
  await manager.perform({ action: 'download_mode', mode: 'direct' })
  await manager.perform({ action: 'source_refresh', id: manager.state.sources[0].id })
  assert.equal(fetches.at(-1).agent, undefined)
})

test('fixed port credentials persist; repeat export reuses proxy; unavailable bound slot cannot auto-switch', async (t) => {
  const { manager, pool, runtime, dir } = fixture(t)
  pool.ensureLocal()
  await add(manager)
  await manager.perform({ action: 'start' })
  const id = manager.status().nodes[0].id
  await manager.perform({ action: 'node_export', ids: [id] })
  const binding = structuredClone(manager.state.bindings[id])
  await manager.perform({ action: 'node_export', ids: [id] })
  assert.deepEqual(manager.state.bindings[id], binding)
  const proxyId = managedProxyId(id)
  assert.equal(pool.snapshot().proxies.filter((p) => p.id === proxyId).length, 1)
  assert.equal(pool.bind(proxyId, 'slot').ok, true)
  assert.equal(pool.bind(proxyId, 'remote').ok, false)
  assert.equal(pool.update(proxyId, { port: 1 }).ok, false)
  assert.equal(pool.remove(proxyId).ok, false)
  await assert.rejects(manager.perform({ action: 'node_unexport', id }), /解除/)
  await manager.perform({ action: 'node_disable', id })
  assert.equal(pool.allocateForVm('slot'), null)
  assert.equal(pool.ensureBoundToVm('slot', proxyId), null)
  assert.equal(runtime.configs.at(-1).listeners.find((l) => l.name === id).proxy, 'REJECT')
  await manager.perform({ action: 'node_enable', id })
  assert.equal(pool.getProxyForVm('slot').id, proxyId)
  const restored = new MihomoManager({ dataDir: dir, proxyPool: pool, runtime })
  assert.deepEqual(restored.state.bindings[id], binding)
  await restored.restore()
  assert.equal(runtime.running, true)
})

test('removing and re-exporting a proxy reserves the old node port; endpoints cannot be edited', async (t) => {
  const { manager, pool } = fixture(t)
  await add(manager)
  await manager.perform({ action: 'start' })
  const id = manager.status().nodes[0].id
  await manager.perform({ action: 'node_export', id })
  const port = manager.state.bindings[id].port
  await manager.perform({ action: 'node_unexport', id })
  assert.equal(pool.snapshot().proxies.length, 0)
  assert.equal(manager.state.bindings[id].port, port)
  await manager.perform({ action: 'node_export', id })
  assert.equal(manager.state.bindings[id].port, port)
})

test('isolated diagnostics do not mutate node state or persistent configuration', async (t) => {
  const { manager } = fixture(t, { probeImpl: async () => ({ success: false, latency_ms: 0 }) })
  await add(manager)
  const id = manager.status().nodes[0].id
  await manager.perform({ action: 'node_disable', id })
  const before = fs.readFileSync(manager.file, 'utf8')
  await manager.test(id, true)
  assert.equal(fs.readFileSync(manager.file, 'utf8'), before)
  assert.equal(manager.status().nodes[0].enabled, false)
  assert.equal(manager.status().nodes[0].check.success, false)
})

test('concurrent management is rejected without committing an in-flight download twice', async (t) => {
  let release
  const { manager } = fixture(t, {
    fetchImpl: () =>
      new Promise((r) => {
        release = () => r({ ok: true, text: async () => subscription() })
      }),
  })
  const first = add(manager)
  await assert.rejects(manager.perform({ action: 'download_mode', mode: 'direct' }), /正在处理/)
  release()
  await first
  assert.equal(manager.state.sources.length, 1)
})

test('quality result is based on actual target responses, not TCP greeting', async () => {
  const result = await checkExit('socks5h://127.0.0.1:9', true, {
    fetchImpl: async (url) => ({ status: url.includes('gstatic') ? 503 : 200 }),
    geoImpl: async () => ({ ok: false }),
  })
  assert.equal(result.success, false)
  assert.equal(result.quality.passed, 2)
  assert.equal(result.geo_ok, false)
})

test('install defaults to latest, exposes progress, starts listeners and persists autostart', async (t) => {
  const { manager, runtime } = fixture(t)
  const install = runtime.install.bind(runtime)
  let proceed
  const pending = new Promise((resolve) => {
    proceed = resolve
  })
  runtime.install = async (options) => {
    await install(options)
    await pending
  }
  const work = manager.perform({ action: 'install' })
  assert.equal(manager.status().busy, true)
  assert.equal(manager.status().install_progress.stage, 'downloading')
  assert.equal(manager.status().install_progress.downloaded_bytes, 4)
  assert.equal(runtime.installVersion, 'latest')
  proceed()
  await work
  assert.equal(manager.status().running, true)
  assert.equal(manager.status().version, 'v1.19.32')
  assert.equal(manager.status().install_progress.stage, 'complete')
  assert.equal(JSON.parse(fs.readFileSync(manager.file, 'utf8')).autostart, true)
  assert.equal(runtime.configs[0].listeners.length, 1)
})

test('explicit install version and live update information do not depend on a hardcoded version', async (t) => {
  const { manager, runtime } = fixture(t)
  await manager.perform({ action: 'check_update' })
  assert.equal(manager.status().version, 'v1.19.31')
  assert.equal(manager.status().latest_version, 'v1.19.32')
  await manager.perform({ action: 'install', version: 'v1.20.1' })
  assert.equal(runtime.installVersion, 'v1.20.1')
  assert.equal(manager.status().version, 'v1.20.1')
})

test('download failure preserves installed version and running state, records a visible failure', async (t) => {
  const { manager, runtime } = fixture(t)
  runtime.install = async () => {
    throw fault('kernel_download_failed', '下载失败', 502)
  }
  await assert.rejects(manager.perform({ action: 'install' }), { code: 'kernel_download_failed' })
  assert.equal(runtime.version, 'v1.19.31')
  assert.equal(runtime.running, false)
  assert.equal(manager.status().install_progress.stage, 'failed')
  assert.equal(manager.status().install_progress.message, '下载失败')
  assert.equal(manager.status().busy, false)
})

test('startup failure distinguishes an installed kernel and permits a successful start retry', async (t) => {
  const { manager, runtime } = fixture(t)
  const start = runtime.start.bind(runtime)
  runtime.start = async () => {
    throw fault('kernel_start_failed', '监听端口不可用', 502)
  }
  await assert.rejects(manager.perform({ action: 'install' }), /内核已安装，但启动失败：监听端口不可用/)
  assert.equal(manager.status().installed, true)
  assert.equal(manager.status().running, false)
  assert.equal(manager.state.autostart, false)
  assert.equal(manager.status().install_progress.stage, 'failed')
  runtime.start = start
  await manager.perform({ action: 'start' })
  assert.equal(manager.status().running, true)
  assert.equal(manager.status().install_progress, null)
  assert.equal(manager.status().error, null)
})

test('restore reads the installed version even when autostart is disabled', async (t) => {
  const { manager, runtime } = fixture(t)
  runtime.detectVersion = async () => {
    runtime.version = 'v1.20.3'
  }
  await manager.restore()
  assert.equal(manager.status().version, 'v1.20.3')
  assert.equal(runtime.running, false)
})

test('blank source names use a visible default and blank renames retain the existing name', async (t) => {
  const { manager } = fixture(t)
  await manager.perform({ action: 'source_add', url: 'https://source.example', label: '   ' })
  const source = manager.status().sources[0]
  assert.equal(source.label, '订阅 1')
  await manager.perform({ action: 'source_rename', id: source.id, label: '  主用订阅  ' })
  await manager.perform({ action: 'source_rename', id: source.id, label: '   ' })
  assert.equal(manager.status().sources[0].label, '主用订阅')
  await manager.perform({ action: 'dynamic_add', text: 'http://dynamic.example:8000', label: '   ' })
  assert.equal(manager.status().sources[1].label, '动态代理')
})

test('HTTP subscription failures close the response body and preserve the cached source', async (t) => {
  const { manager } = fixture(t)
  await add(manager)
  const before = fs.readFileSync(manager.file, 'utf8')
  let closed = 0
  manager.fetch = async () => ({
    ok: false,
    status: 403,
    body: {
      destroy() {
        closed++
      },
    },
  })
  await assert.rejects(manager.perform({ action: 'source_refresh', id: manager.state.sources[0].id }), {
    code: 'subscription_http_failed',
  })
  assert.equal(closed, 1)
  assert.equal(fs.readFileSync(manager.file, 'utf8'), before)
  assert.equal(manager.status().nodes.length, 1)
})

test('closing during an installation aborts the download and never starts or enables autostart', async (t) => {
  const { manager, runtime } = fixture(t)
  let signal
  runtime.install = (options) => {
    signal = options.signal
    return new Promise((resolve, reject) =>
      signal.addEventListener('abort', () => reject(fault('cancelled', '已取消', 409)), { once: true }),
    )
  }
  const installing = manager.perform({ action: 'install' })
  const rejected = assert.rejects(installing, { code: 'cancelled' })
  await manager.close()
  await rejected
  assert.equal(signal.aborted, true)
  assert.equal(runtime.configs.length, 0)
  assert.equal(runtime.running, false)
  assert.equal(manager.state.autostart, false)
  assert.equal(fs.existsSync(manager.file), false)
})

test('closing during startup stops a late-ready kernel without persisting autostart', async (t) => {
  const { manager, runtime } = fixture(t)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  runtime.start = async () => {
    entered.resolve()
    await release.promise
    runtime.running = true
  }
  const starting = manager.perform({ action: 'start' })
  await entered.promise
  const rejected = assert.rejects(starting, { code: 'closed' })
  const closing = manager.close()
  release.resolve()
  await Promise.all([rejected, closing])
  assert.equal(runtime.running, false)
  assert.equal(manager.state.autostart, false)
  assert.equal(fs.existsSync(manager.file), false)
})

test('closing while applying a source preserves the previous persisted configuration', async (t) => {
  const { manager, runtime } = fixture(t)
  await add(manager)
  const before = fs.readFileSync(manager.file, 'utf8')
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let calls = 0
  runtime.apply = async () => {
    if (++calls === 1) {
      entered.resolve()
      await release.promise
    }
  }
  const changing = manager.perform({ action: 'source_rename', id: manager.state.sources[0].id, label: 'changed' })
  await entered.promise
  const rejected = assert.rejects(changing, { code: 'closed' })
  const closing = manager.close()
  release.resolve()
  await Promise.all([rejected, closing])
  assert.equal(fs.readFileSync(manager.file, 'utf8'), before)
  assert.notEqual(manager.status().sources[0].label, 'changed')
})

test('subscription HTTP errors abort an unfinished real HTTP socket', async (t) => {
  let socket
  const server = http.createServer((_req, res) => {
    res.writeHead(403)
    res.write('unfinished authentication error')
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
  const { manager } = fixture(t, { fetchImpl: nodeFetch })
  await assert.rejects(add(manager, `http://127.0.0.1:${server.address().port}`), { code: 'subscription_http_failed' })
  if (!socket.destroyed) await once(socket, 'close', { signal: AbortSignal.timeout(1000) })
  assert.equal(socket.destroyed, true)
})
