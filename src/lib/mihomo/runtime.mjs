import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import nodeFetch from 'node-fetch'
import { fault } from './config.mjs'
import { resolveMihomoRelease, downloadMihomoRelease } from './releases.mjs'

const exec = promisify(execFile)
const binaryVersion = (stdout) => /\bMihomo(?: Meta)?\s+(\S+)/i.exec(stdout)?.[1] || null

async function runBinary(binary, args, options) {
  const command = exec(binary, args, options)
  const closed = new Promise((resolve) => command.child.once('close', resolve))
  try {
    return await command
  } finally {
    await closed
  }
}

export function atomicJson(file, value) {
  const tmp = `${file}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

export async function availablePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(preferred, '127.0.0.1', () => {
      const port = server.address().port
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

export class MihomoRuntime {
  constructor({ dir, binary, onExit = () => {}, fetchImpl = nodeFetch }) {
    this.dir = dir
    this.binary = binary || process.env.KIN_MIHOMO_BIN || path.join(dir, 'mihomo')
    this.onExit = onExit
    this.fetch = fetchImpl
    this.version = null
    this.latestVersion = null
    this.external = !!process.env.KIN_MIHOMO_BIN
    this.child = null
    this.starting = null
    this.startAbort = null
    this.stopping = null
    this.port = null
    this.secret = randomBytes(24).toString('hex')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }

  get installed() {
    return fs.existsSync(this.binary)
  }
  get running() {
    return (
      !!this.child &&
      this.child.exitCode == null &&
      this.child.signalCode == null &&
      !this.child.killed &&
      !this.stopping
    )
  }

  async detectVersion() {
    if (!this.installed) {
      this.version = null
      return
    }
    try {
      const { stdout } = await runBinary(this.binary, ['-v'], { timeout: 10000, windowsHide: true })
      this.version = binaryVersion(stdout)
      if (!this.version) throw new Error('version missing')
    } catch {
      this.version = null
      throw fault('kernel_version_failed', '无法读取已安装内核的版本，请重新安装或检查内核文件', 500)
    }
  }

  async checkUpdate({ signal } = {}) {
    const release = await resolveMihomoRelease('latest', { fetchImpl: this.fetch, signal })
    this.latestVersion = release.version
    return release
  }

  async install({ version = 'latest', config, onProgress = () => {}, signal } = {}) {
    if (this.child || this.starting || this.stopping) throw fault('kernel_running', '请先停止内核再安装', 409)
    if (this.external) throw fault('external_kernel', 'KIN_MIHOMO_BIN 指定的内核由部署者管理', 409)
    if (process.platform !== 'linux')
      throw fault('unsupported_platform', '自动安装支持 Linux amd64/arm64；开发环境可设置 KIN_MIHOMO_BIN', 409)
    onProgress({ stage: 'resolving', version, downloaded_bytes: 0, total_bytes: null })
    const release =
      version === 'latest'
        ? await this.checkUpdate({ signal })
        : await resolveMihomoRelease(version, { fetchImpl: this.fetch, signal })
    const bytes = await downloadMihomoRelease(release, { fetchImpl: this.fetch, onProgress, signal })
    const candidate = `${this.binary}.download`
    onProgress({
      stage: 'installing',
      version: release.version,
      downloaded_bytes: bytes.length,
      total_bytes: release.size,
    })
    try {
      signal?.throwIfAborted()
      fs.writeFileSync(candidate, gunzipSync(bytes, { maxOutputLength: 150 * 1024 * 1024 }), { mode: 0o700 })
      const { stdout } = await runBinary(candidate, ['-v'], {
        timeout: 10000,
        windowsHide: true,
        signal,
        killSignal: 'SIGKILL',
      })
      if (binaryVersion(stdout) !== release.version) throw new Error('version mismatch')
      if (config) await this.validate(config, candidate, { signal })
      signal?.throwIfAborted()
      fs.renameSync(candidate, this.binary)
      this.version = release.version
    } catch (error) {
      if (signal?.aborted) throw fault('kernel_operation_cancelled', 'Mihomo 内核操作已取消；原内核未改动', 409)
      if (error.code === 'kernel_config_invalid')
        throw fault('kernel_install_config_invalid', '该版本无法加载现有节点配置，原内核未改动', 400)
      throw fault('kernel_install_failed', 'Mihomo 安装失败，原内核未改动', 500)
    } finally {
      fs.rmSync(candidate, { force: true })
    }
  }

  async validate(config, binary = this.binary, { signal } = {}) {
    if (!fs.existsSync(binary)) throw fault('kernel_missing', '请先安装 Mihomo 内核', 409)
    const candidate = path.join(this.dir, 'candidate.json')
    try {
      atomicJson(candidate, config)
      await runBinary(binary, ['-t', '-d', this.dir, '-f', candidate], {
        timeout: 15000,
        signal,
        killSignal: 'SIGKILL',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
    } catch (error) {
      if (error.code === 'kernel_missing') throw error
      throw fault('kernel_config_invalid', 'Mihomo 配置校验失败；原配置未替换，请检查节点协议和字段')
    } finally {
      fs.rmSync(candidate, { force: true })
    }
  }

  async request(method, route, body, signal) {
    const abort = new AbortController()
    let res
    try {
      res = await nodeFetch(`http://127.0.0.1:${this.port}${route}`, {
        method,
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
        ...(body == null ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
        size: 4 * 1024 * 1024,
      })
      if (!res.ok) throw fault('kernel_control_failed', 'Mihomo 控制接口拒绝操作', 502)
      return res.status === 204 ? null : await res.json()
    } finally {
      abort.abort()
      res?.body?.destroy()
    }
  }

  controllerConfig(config) {
    return { ...config, 'external-controller': `127.0.0.1:${this.port}`, secret: this.secret }
  }

  async start(config, { signal } = {}) {
    if (this.child || this.starting || this.stopping) throw fault('kernel_running', 'Mihomo 已运行或正在启停', 409)
    const abort = new AbortController()
    this.startAbort = abort
    this.starting = this.startCore(config, signal ? AbortSignal.any([abort.signal, signal]) : abort.signal)
    try {
      await this.starting
    } finally {
      this.starting = null
      this.startAbort = null
    }
  }

  async startCore(config, signal) {
    let ready = false
    try {
      await this.validate(config, this.binary, { signal })
      signal.throwIfAborted()
      for (const listener of config.listeners) {
        await availablePort(listener.port).catch(() => {
          throw fault('port_in_use', 'Mihomo 监听端口被占用；未改变节点绑定', 409)
        })
        signal.throwIfAborted()
      }
      this.port = await availablePort()
      signal.throwIfAborted()
      const file = path.join(this.dir, 'runtime.json')
      atomicJson(file, this.controllerConfig(config))
      const child = spawn(this.binary, ['-d', this.dir, '-f', file], { stdio: 'ignore', windowsHide: true })
      this.child = child
      child.once('error', () => {
        if (this.child === child && !child.pid) this.child = null
      })
      child.once('exit', () => {
        if (this.child !== child) return
        this.child = null
        if (!this.stopping) this.onExit()
      })
      for (let i = 0; i < 50 && !signal.aborted && this.running; i++) {
        try {
          const info = await this.request('GET', '/version', undefined, signal)
          if (signal.aborted || this.child !== child || !this.running) break
          this.version = info.version || this.version
          // The controller starts before listeners; a synchronous apply confirms readiness.
          await this.request(
            'PUT',
            '/configs?force=true',
            { payload: JSON.stringify(this.controllerConfig(config)) },
            signal,
          )
          if (signal.aborted || this.child !== child || !this.running) break
          ready = true
          return
        } catch {
          await delay(100, undefined, { signal })
        }
      }
      throw fault('kernel_start_failed', 'Mihomo 未能启动，节点出口保持不可用', 502)
    } catch (error) {
      if (signal.aborted) throw fault('kernel_start_failed', 'Mihomo 启动已取消，节点出口保持不可用', 502)
      throw error
    } finally {
      if (!ready) await this.stopChild()
    }
  }

  async apply(config, rejectNodes = []) {
    await this.validate(config)
    if (!this.running) return
    await this.request('PUT', '/configs?force=true', { payload: JSON.stringify(this.controllerConfig(config)) })
    if (rejectNodes.length) {
      const blocked = new Set(rejectNodes)
      const active = await this.request('GET', '/connections')
      for (const connection of active?.connections || []) {
        if (blocked.has(connection.metadata?.inboundName) || connection.chains?.some((id) => blocked.has(id)))
          await this.request('DELETE', `/connections/${encodeURIComponent(connection.id)}`)
      }
    }
    atomicJson(path.join(this.dir, 'runtime.json'), this.controllerConfig(config))
  }

  async stopChild() {
    if (this.stopping) return this.stopping
    const child = this.child
    if (!child) return
    this.stopping = new Promise((resolve, reject) => {
      if (child.exitCode != null || child.signalCode != null) return resolve()
      const cleanup = () => {
        clearTimeout(timer)
        child.removeListener('close', closed)
        child.removeListener('error', failed)
      }
      const closed = () => {
        cleanup()
        resolve()
      }
      const failed = () => {
        cleanup()
        reject(fault('kernel_stop_failed', 'Mihomo 未能停止，无法确认监听端口已释放', 500))
      }
      const kill = (signal) => {
        try {
          child.kill(signal)
        } catch {
          failed()
        }
      }
      const timer = setTimeout(() => kill('SIGKILL'), 3000)
      child.once('close', closed)
      child.once('error', failed)
      kill('SIGTERM')
    })
    try {
      await this.stopping
      if (this.child === child) this.child = null
    } finally {
      this.stopping = null
    }
  }

  async stop() {
    const starting = this.starting
    this.startAbort?.abort()
    await this.stopChild()
    await starting?.catch(() => {})
  }
}
