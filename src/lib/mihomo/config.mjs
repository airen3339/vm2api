import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'

export const MAX_SOURCE_BYTES = 4 * 1024 * 1024
export const MAX_NODES = 4096
const TYPES = new Set([
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'snell',
  'socks5',
  'http',
  'anytls',
  'mieru',
])
const UNSAFE_KEYS = new Set([
  'dialer-proxy',
  'interface-name',
  'routing-mark',
  'certificate',
  'private-key',
  'client-auth-cert',
])

export function fault(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    )
  return value
}

export function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !TYPES.has(raw.type))
    throw fault('invalid_node', '订阅包含不支持的节点类型')
  if (typeof raw.server !== 'string' || !raw.server.trim() || raw.server.length > 253 || /[\s/@\\]/.test(raw.server))
    throw fault('invalid_node', '节点服务器地址无效')
  const port = Number(raw.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fault('invalid_node', '节点端口无效')
  for (const key of UNSAFE_KEYS)
    if (Object.hasOwn(raw, key))
      throw fault('unsafe_node', '节点包含链式代理、接口覆盖或本地文件配置，请先移除这些字段')
  if (raw.plugin && !['obfs', 'v2ray-plugin', 'shadow-tls', 'restls'].includes(raw.plugin))
    throw fault('unsafe_node', '不支持此节点插件')
  if (
    raw['ip-version'] !== undefined &&
    !['dual', 'ipv4', 'ipv6', 'ipv4-prefer', 'ipv6-prefer'].includes(raw['ip-version'])
  )
    throw fault('invalid_node', '节点 ip-version 必须为 dual、ipv4、ipv6、ipv4-prefer 或 ipv6-prefer')
  const { name, ...config } = raw
  config.server = config.server.trim()
  config.port = port
  const serialized = JSON.stringify(canonical(config))
  if (serialized.length > 16384) throw fault('node_too_large', '单个节点配置过大')
  const id = `mh-${createHash('sha256').update(serialized).digest('hex').slice(0, 24)}`
  return { id, label: String(name || raw.type).slice(0, 120), config }
}

export function parseSubscription(text) {
  if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) throw fault('source_too_large', '订阅超过 4 MiB 限制')
  let value
  try {
    const doc = parseDocument(text, { schema: 'core', uniqueKeys: true })
    if (doc.errors.length) throw new Error('yaml')
    value = doc.toJS({ maxAliasCount: 20 })
  } catch {
    throw fault('invalid_subscription', '无法解析 Clash/Mihomo YAML 订阅')
  }
  if (!Array.isArray(value?.proxies) || !value.proxies.length || value.proxies.length > MAX_NODES)
    throw fault('invalid_subscription', '订阅必须包含 1–4096 个 proxies 节点')
  const nodes = value.proxies.map((raw, index) => {
    try {
      return normalizeNode(raw)
    } catch (error) {
      throw fault(error.code, '第 ' + (index + 1) + ' 个节点：' + error.message)
    }
  })
  return [...new Map(nodes.map((n) => [n.id, n])).values()]
}

export function subscriptionUrl(value) {
  let u
  try {
    u = new URL(value)
  } catch {
    throw fault('invalid_url', '请输入有效的 HTTP(S) 订阅地址')
  }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.href.length > 4096)
    throw fault('invalid_url', '订阅仅支持不带用户名密码的 HTTP(S) 地址')
  return u.href
}

export function parseDynamic(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!lines.length || lines.length > MAX_NODES) throw fault('invalid_dynamic', '请输入 1–4096 个代理地址')
  return [
    ...new Map(
      lines.map((line) => {
        let u
        try {
          u = new URL(line)
        } catch {
          throw fault('invalid_dynamic', '动态代理需使用 socks5://、http:// 或 https:// 地址')
        }
        if (
          !['socks5:', 'socks5h:', 'http:', 'https:'].includes(u.protocol) ||
          u.search ||
          (u.pathname && u.pathname !== '/')
        )
          throw fault('invalid_dynamic', '动态代理协议或地址格式不支持')
        let node
        try {
          node = normalizeNode({
            name: decodeURIComponent(u.hash.slice(1)) || '动态代理',
            type: u.protocol.startsWith('socks') ? 'socks5' : 'http',
            server: u.hostname.replace(/^\[|\]$/g, ''),
            port: Number(u.port || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : 1080)),
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password),
            ...(u.protocol === 'https:' ? { tls: true } : {}),
          })
        } catch {
          throw fault('invalid_dynamic', '动态代理地址或凭据编码无效')
        }
        return [node.id, node]
      }),
    ).values(),
  ]
}

export function collectNodes(state) {
  const nodes = new Map()
  for (const source of state.sources)
    for (const node of source.nodes) {
      const current = nodes.get(node.id) || { ...node, source_ids: [], enabled: false, dynamic: false }
      current.source_ids.push(source.id)
      current.enabled ||= source.enabled
      current.dynamic ||= source.kind === 'dynamic'
      nodes.set(node.id, current)
    }
  for (const node of nodes.values()) node.enabled &&= !state.disabled.includes(node.id)
  return nodes
}

export function socksListener(name, binding, target) {
  return {
    name,
    type: 'socks',
    listen: '127.0.0.1',
    port: binding.port,
    udp: false,
    users: [{ username: binding.username, password: binding.password }],
    proxy: target,
  }
}

export function kernelConfig(state) {
  const nodes = collectNodes(state)
  const active = [...nodes.values()].filter((n) => n.enabled)
  return {
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': 'silent',
    'geo-auto-update': false,
    'find-process-mode': 'off',
    dns: { enable: false },
    profile: { 'store-selected': false, 'store-fake-ip': false },
    proxies: active.map((n) => ({ ...n.config, name: n.id })),
    listeners: [
      ...(state.download ? [socksListener('subscription-download', state.download, active[0]?.id || 'REJECT')] : []),
      ...Object.entries(state.bindings).map(([id, b]) =>
        socksListener(id, b, b.active && nodes.get(id)?.enabled ? id : 'REJECT'),
      ),
    ],
    rules: ['MATCH,REJECT'],
  }
}

export function localProxyUrl(binding) {
  return `socks5h://${encodeURIComponent(binding.username)}:${encodeURIComponent(binding.password)}@127.0.0.1:${binding.port}`
}
