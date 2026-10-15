import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import nodeFetch from 'node-fetch'
import { createProxyAgent } from '../vm/proxy-agent.mjs'
import { lookupProxyGeo } from '../vm/proxy-geo.mjs'
import {
  MAX_SOURCE_BYTES,
  MAX_NODES,
  fault,
  collectNodes,
  parseSubscription,
  parseDynamic,
  subscriptionUrl,
  kernelConfig,
  localProxyUrl,
  socksListener,
} from './config.mjs'
import { MihomoRuntime, atomicJson, availablePort } from './runtime.mjs'

export const managedProxyId = (id) => `px-${id}`
export const managedNodeId = (id) => (/^px-mh-[a-f0-9]{24}$/.test(id || '') ? id.slice(3) : null)
const credentials = (port) => ({ port, username: 'vm2api', password: randomBytes(24).toString('hex') })
const label = (value, fallback) =>
  String(value || fallback)
    .trim()
    .slice(0, 80) || fallback

export class MihomoManager {
  constructor({ dataDir, proxyPool, runtime, fetchImpl = nodeFetch, probeImpl, binary } = {}) {
    this.dir = path.join(dataDir, 'mihomo')
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.file = path.join(this.dir, 'settings.json')
    this.pool = proxyPool
    this.fetch = fetchImpl
    this.probeImpl = probeImpl
    this.busy = false
    this.closed = false
    this.error = null
    this.installProgress = null
    this.checks = new Map()
    this.probes = new Set()
    this.pendingChecks = new Set()
    this.probeRuntimes = new Set()
    this.abort = new AbortController()
    this.runtime =
      runtime ||
      new MihomoRuntime({
        dir: this.dir,
        binary,
        onExit: () => {
          this.error = 'Mihomo 已退出，节点出口不可用'
          this.syncPool()
        },
      })
    this.state = this.readState()
    this.syncPool()
  }

  readState() {
    const state = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, 'utf8'))
      : { version: 1, autostart: false, download_mode: 'auto', sources: [], disabled: [], bindings: {}, download: null }
    if (state.version !== 1 || !Array.isArray(state.sources) || !state.bindings)
      throw fault('invalid_state', 'Mihomo 配置无法读取，拒绝覆盖已有数据', 500)
    return state
  }

  async reload() {
    this.state = this.readState()
    this.checks.clear()
    try {
      if (this.state.autostart) await this.runtime.start(kernelConfig(this.state), { signal: this.abort.signal })
    } finally {
      this.syncPool()
    }
  }

  status() {
    const nodes = [...collectNodes(this.state).values()]
    const proxies = new Map((this.pool?.snapshot().proxies || []).map((p) => [p.id, p]))
    return {
      installed: this.runtime.installed,
      running: this.runtime.running,
      version: this.runtime.version || null,
      latest_version: this.runtime.latestVersion || null,
      external_kernel: !!this.runtime.external,
      install_progress: this.installProgress,
      busy: this.busy,
      error: this.error,
      download_mode: this.state.download_mode,
      sources: this.state.sources.map((s) => ({
        id: s.id,
        label: s.label,
        kind: s.kind,
        enabled: s.enabled,
        nodes: s.nodes.length,
        updated_at: s.updated_at,
      })),
      nodes: nodes.map((n) => {
        const proxy = proxies.get(managedProxyId(n.id))
        return {
          id: n.id,
          label: n.label,
          type: n.config.type,
          enabled: n.enabled,
          dynamic: n.dynamic,
          source_ids: n.source_ids,
          proxy_id: this.state.bindings[n.id]?.exported ? managedProxyId(n.id) : null,
          outlet: this.state.bindings[n.id]?.exported
            ? {
                enabled: !!proxy?.enabled,
                status: proxy?.status || 'unknown',
                error: proxy?.last_error || null,
                bound_count: proxy?.bound_count || 0,
              }
            : null,
          check: this.checks.get(n.id) || null,
        }
      }),
    }
  }

  syncPool() {
    if (!this.pool) return
    const nodes = collectNodes(this.state)
    const records = []
    for (const [id, b] of Object.entries(this.state.bindings)) {
      if (!b.exported) continue
      records.push({
        id: managedProxyId(id),
        host: '127.0.0.1',
        port: b.port,
        username: b.username,
        password: b.password,
        label: `Mihomo · ${nodes.get(id)?.label || id}`.slice(0, 64),
        enabled: !!(this.runtime.running && b.active && nodes.get(id)?.enabled),
      })
    }
    this.pool.syncManaged(records)
  }

  async restore() {
    try {
      await this.runtime.detectVersion?.()
      if (!this.state.autostart) return
      await this.exclusive(async () => {
        await this.runtime.start(kernelConfig(this.state), { signal: this.abort.signal })
        this.syncPool()
      })
    } catch (error) {
      this.error = error.message
    }
  }

  async exclusive(work, { preserveError = false } = {}) {
    if (this.closed) throw fault('closed', 'Mihomo 管理器已关闭', 409)
    if (this.busy) throw fault('busy', 'Mihomo 正在处理操作，请稍后再试', 409)
    this.busy = true
    this.error = null
    if (this.pool) this.pool.managedBusy = true
    try {
      this.work = work()
      return await this.work
    } catch (error) {
      if (preserveError) throw error
      this.error = error.code && error.status ? error.message : 'Mihomo 操作失败，未应用新配置'
      if (error.code && error.status) throw error
      throw fault('mihomo_operation_failed', this.error, 500)
    } finally {
      if (this.pool) this.pool.managedBusy = false
      this.busy = false
      this.work = null
    }
  }

  async commit(next) {
    if (this.closed) throw fault('closed', 'Mihomo 管理器已关闭', 409)
    if (collectNodes(next).size > MAX_NODES) throw fault('too_many_nodes', '节点总数超过 4096')
    const previous = this.state
    const oldNodes = collectNodes(previous)
    const nodes = collectNodes(next)
    const rejected = [...oldNodes.keys()].filter(
      (id) => !nodes.get(id)?.enabled || (previous.bindings[id]?.active && !next.bindings[id]?.active),
    )
    try {
      await this.runtime.apply(kernelConfig(next), rejected)
      if (this.closed) throw fault('closed', 'Mihomo 管理器已关闭，未应用新配置', 409)
      atomicJson(this.file, next)
    } catch (error) {
      try {
        await this.runtime.apply(kernelConfig(previous))
      } catch {
        await this.runtime.stop()
      }
      this.syncPool()
      throw error
    }
    this.state = next
    this.syncPool()
    for (const id of this.checks.keys()) if (!nodes.has(id)) this.checks.delete(id)
  }

  async reserve(next) {
    const used = new Set([...Object.values(next.bindings).map((b) => b.port), next.download?.port].filter(Boolean))
    for (let port = 32000; port < 42000; port++) {
      if (used.has(port)) continue
      try {
        await availablePort(port)
        return credentials(port)
      } catch {
        /* try next unoccupied port */
      }
    }
    throw fault('no_ports', '没有可用的 Mihomo 本地监听端口', 409)
  }

  async download(url) {
    const mode = this.state.download_mode
    const via = this.runtime.running && this.state.download ? localProxyUrl(this.state.download) : null
    if (mode === 'proxy' && !via)
      throw fault('download_proxy_unavailable', '仅代理下载需要运行中的 Mihomo；不会回退直连', 409)
    const routes = mode === 'direct' ? [null] : mode === 'proxy' ? [via] : via ? [via, null] : [null]
    let failure
    for (const route of routes) {
      const agent = route ? createProxyAgent(route) : null
      const abort = new AbortController()
      let response
      try {
        response = await this.fetch(url, {
          signal: AbortSignal.any([this.abort.signal, abort.signal, AbortSignal.timeout(30000)]),
          size: MAX_SOURCE_BYTES,
          redirect: 'follow',
          follow: 5,
          agent: agent || undefined,
          headers: { 'user-agent': 'mihomo/vm2api', accept: 'text/yaml,application/yaml,text/plain' },
        })
        if (!response.ok) {
          throw fault(
            'subscription_http_failed',
            response.status === 401 || response.status === 403
              ? '订阅认证失败，请检查订阅地址是否有效或已过期'
              : '订阅服务器返回 HTTP ' + response.status,
            502,
          )
        }
        return parseSubscription(await response.text())
      } catch (error) {
        failure = error.status
          ? error
          : fault('subscription_download_failed', '订阅下载失败，请检查网络或下载模式', 502)
      } finally {
        abort.abort()
        response?.body?.destroy()
        agent?.destroy()
      }
    }
    throw fault(failure.code, failure.message + '；原节点保留', failure.status)
  }

  async start(next) {
    if (this.closed) throw fault('closed', 'Mihomo 管理器已关闭', 409)
    next.download ||= await this.reserve(next)
    await this.runtime.start(kernelConfig(next), { signal: this.abort.signal })
    if (this.closed) {
      await this.runtime.stop()
      throw fault('closed', 'Mihomo 管理器已关闭，未保存自启动配置', 409)
    }
    next.autostart = true
    try {
      atomicJson(this.file, next)
    } catch (error) {
      await this.runtime.stop()
      throw error
    }
    this.state = next
    this.syncPool()
  }

  async perform(body) {
    return this.exclusive(async () => {
      const next = structuredClone(this.state)
      const action = body.action
      if (action !== 'install') this.installProgress = null
      const source = next.sources.find((s) => s.id === body.id)
      const ids = [...new Set(Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [])]
      if (ids.length > 100) throw fault('too_many_targets', '单次最多操作 100 个节点')
      switch (action) {
        case 'check_update':
          await this.runtime.checkUpdate({ signal: this.abort.signal })
          return this.status()
        case 'install': {
          this.installProgress = {
            stage: 'resolving',
            version: body.version || 'latest',
            downloaded_bytes: 0,
            total_bytes: null,
          }
          let installed = false
          try {
            await this.runtime.install({
              version: body.version ?? 'latest',
              config: kernelConfig(next),
              signal: this.abort.signal,
              onProgress: (progress) => {
                this.installProgress = progress
              },
            })
            installed = true
            this.installProgress = {
              ...this.installProgress,
              stage: 'starting',
              version: this.runtime.version || this.installProgress.version,
            }
            await this.start(next)
            this.installProgress = { ...this.installProgress, stage: 'complete' }
            return this.status()
          } catch (error) {
            const message = installed
              ? '内核已安装，但启动失败：' + (error.status ? error.message : '请检查服务器日志后重试启动')
              : error.status
                ? error.message
                : '内核安装失败，请重试'
            this.installProgress = { ...this.installProgress, stage: 'failed', message }
            throw fault(error.code || 'kernel_install_failed', message, error.status || 500)
          }
        }
        case 'start':
          await this.start(next)
          return this.status()
        case 'stop':
          next.autostart = false
          atomicJson(this.file, next)
          this.state = next
          await this.runtime.stop()
          this.syncPool()
          return this.status()
        case 'download_mode':
          if (!['direct', 'proxy', 'auto'].includes(body.mode)) throw fault('invalid_mode', '下载模式无效')
          next.download_mode = body.mode
          atomicJson(this.file, next)
          this.state = next
          return this.status()
        case 'source_add': {
          if (next.sources.length >= 64) throw fault('too_many_sources', '最多支持 64 个来源')
          const url = subscriptionUrl(body.url)
          if (next.sources.some((s) => s.url === url)) throw fault('duplicate_source', '订阅已存在')
          const nodes = await this.download(url)
          next.sources.push({
            id: randomUUID(),
            label: label(body.label, `订阅 ${next.sources.length + 1}`),
            kind: 'subscription',
            url,
            enabled: true,
            nodes,
            updated_at: new Date().toISOString(),
          })
          break
        }
        case 'dynamic_add':
          if (next.sources.length >= 64) throw fault('too_many_sources', '最多支持 64 个来源')
          next.sources.push({
            id: randomUUID(),
            label: label(body.label, '动态代理'),
            kind: 'dynamic',
            enabled: true,
            nodes: parseDynamic(body.text),
            updated_at: new Date().toISOString(),
          })
          break
        case 'source_rename':
        case 'source_refresh':
        case 'source_update':
        case 'source_enable':
        case 'source_disable':
        case 'source_remove': {
          if (!source) throw fault('source_not_found', '来源不存在', 404)
          if (action === 'source_rename') source.label = label(body.label, source.label)
          if (action === 'source_enable') source.enabled = true
          if (action === 'source_disable') source.enabled = false
          if (action === 'source_remove') next.sources = next.sources.filter((s) => s.id !== source.id)
          if (action === 'source_refresh' || action === 'source_update') {
            if (source.kind !== 'subscription') throw fault('not_subscription', '动态代理不使用订阅刷新')
            const url = action === 'source_update' ? subscriptionUrl(body.url) : source.url
            if (action === 'source_update') source.label = label(body.label, source.label)
            if (next.sources.some((s) => s.id !== source.id && s.url === url))
              throw fault('duplicate_source', '订阅已存在')
            source.nodes = await this.download(url)
            source.url = url
            source.updated_at = new Date().toISOString()
          }
          break
        }
        case 'node_enable':
        case 'node_disable':
        case 'node_export':
        case 'node_unexport': {
          const nodes = collectNodes(next)
          if (!ids.length || ids.some((id) => !nodes.has(id) && !(action === 'node_unexport' && next.bindings[id])))
            throw fault('node_not_found', '请选择存在的节点', 404)
          for (const id of ids) {
            if (action === 'node_enable') next.disabled = next.disabled.filter((n) => n !== id)
            if (action === 'node_disable' && !next.disabled.includes(id)) next.disabled.push(id)
            if (action === 'node_export') {
              if (!nodes.get(id).enabled || !this.runtime.running)
                throw fault('node_unavailable', '需先启用节点并启动内核', 409)
              if (!next.bindings[id]) {
                if (Object.keys(next.bindings).length >= MAX_NODES)
                  throw fault('binding_limit', '保留的节点端口已达上限', 409)
                next.bindings[id] = { ...(await this.reserve(next)), active: true, exported: true }
              }
              next.bindings[id].active = true
              next.bindings[id].exported = true
            }
            if (action === 'node_unexport') {
              const p = this.pool?.snapshot().proxies.find((p) => p.id === managedProxyId(id))
              if (p?.bound_vm_ids?.length) throw fault('proxy_in_use', '请先解除该代理的槽位绑定', 409)
              if (next.bindings[id]) {
                next.bindings[id].active = false
                next.bindings[id].exported = false
              }
            }
          }
          break
        }
        default:
          throw fault('invalid_action', '未知的 Mihomo 操作')
      }
      await this.commit(next)
      if (action === 'node_unexport') for (const id of ids) this.pool?.remove(managedProxyId(id), { managed: true })
      return this.status()
    })
  }

  async setProxyEnabled(proxyId, enabled) {
    const id = managedNodeId(proxyId)
    await this.exclusive(async () => {
      if (!this.state.bindings[id]?.exported) throw fault('binding_not_found', '节点绑定不存在', 404)
      const next = structuredClone(this.state)
      if (enabled && (!this.runtime.running || !collectNodes(next).get(id)?.enabled))
        throw fault('node_unavailable', '请先启动内核并启用节点', 409)
      next.bindings[id].active = enabled
      await this.commit(next)
    })
    return { ok: true, proxy: this.pool.snapshot().proxies.find((p) => p.id === proxyId) }
  }

  async test(id, quality = false) {
    if (this.busy) throw fault('busy', 'Mihomo 正在处理操作，请稍后再试', 409)
    const task = this.runTest(id, quality)
    this.pendingChecks.add(task)
    try {
      return await task
    } finally {
      this.pendingChecks.delete(task)
    }
  }

  async runTest(id, quality) {
    if (this.closed) throw fault('closed', 'Mihomo 管理器已关闭', 409)
    const node = collectNodes(this.state).get(id)
    if (!node) throw fault('node_not_found', '节点不存在', 404)
    if (!this.runtime.installed) throw fault('kernel_missing', '请先安装内核', 409)
    if (this.probes.size >= 4 || this.probes.has(id)) throw fault('checks_busy', '已有检测进行中，请稍后再试', 429)
    this.probes.add(id)
    let dir, runtime
    try {
      let result
      if (this.probeImpl) result = await this.probeImpl(node, quality)
      else {
        dir = fs.mkdtempSync(path.join(this.dir, 'probe-'))
        fs.chmodSync(dir, 0o700)
        const b = credentials(await availablePort())
        runtime = new MihomoRuntime({ dir, binary: this.runtime.binary })
        this.probeRuntimes.add(runtime)
        const config = kernelConfig({ sources: [], disabled: [], bindings: {} })
        config.proxies = [{ ...node.config, name: id }]
        config.listeners = [socksListener(id, b, id)]
        await runtime.start(config, { signal: this.abort.signal })
        result = await checkExit(localProxyUrl(b), quality)
      }
      if (collectNodes(this.state).has(id)) this.checks.set(id, { ...result, checked_at: new Date().toISOString() })
      return result
    } catch (error) {
      if (collectNodes(this.state).has(id))
        this.checks.set(id, { success: false, latency_ms: null, geo_ok: false, checked_at: new Date().toISOString() })
      throw error
    } finally {
      await runtime?.stop()
      this.probeRuntimes.delete(runtime)
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
      this.probes.delete(id)
    }
  }

  async close() {
    this.closed = true
    this.abort.abort()
    await this.work?.catch(() => {})
    await Promise.all([...this.probeRuntimes].map((runtime) => runtime.stop()))
    await Promise.allSettled(this.pendingChecks)
    await this.runtime.stop()
  }
}

export async function checkExit(url, quality = false, { fetchImpl = nodeFetch, geoImpl = lookupProxyGeo } = {}) {
  const agent = createProxyAgent(url)
  let latency = null
  const items = []
  try {
    const urls = quality
      ? [
          'https://www.gstatic.com/generate_204',
          'https://www.cloudflare.com/cdn-cgi/trace',
          'https://www.microsoft.com/',
        ]
      : ['https://www.gstatic.com/generate_204']
    for (const target of urls) {
      const start = Date.now()
      try {
        const response = await fetchImpl(target, {
          agent,
          signal: AbortSignal.timeout(8000),
          size: 128 * 1024,
          redirect: 'manual',
        })
        response.body?.destroy()
        items.push({ target: new URL(target).hostname, ok: response.status >= 200 && response.status < 400 })
      } catch {
        items.push({ target: new URL(target).hostname, ok: false })
      }
      if (latency == null) latency = Date.now() - start
    }
    const geo = await geoImpl(url, { timeoutMs: 8000 })
    return {
      success: items[0].ok,
      latency_ms: latency,
      ...(geo.ok ? { geo: geo.geo } : {}),
      geo_ok: geo.ok,
      ...(quality
        ? {
            quality: {
              passed: items.filter((i) => i.ok).length,
              total: items.length,
              items,
              summary: '基础网络连通性检测，不代表模型可用、IP 风险或账号安全',
            },
          }
        : {}),
    }
  } finally {
    agent.destroy()
  }
}
