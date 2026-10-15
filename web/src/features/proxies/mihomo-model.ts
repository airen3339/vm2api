export type MihomoCheck = {
  success: boolean
  latency_ms: number | null
  checked_at?: string
  geo?: { ip?: string; country?: string; country_code?: string }
  quality?: { passed: number; total: number; summary: string }
}
export type MihomoNode = {
  id: string
  label: string
  type: string
  enabled: boolean
  dynamic: boolean
  source_ids: string[]
  proxy_id: string | null
  outlet?: {
    enabled: boolean
    status: string
    error: string | null
    bound_count: number
  } | null
  check: MihomoCheck | null
}
export type MihomoSource = {
  id: string
  label: string
  kind: 'subscription' | 'dynamic'
  enabled: boolean
  nodes: number
  updated_at: string
}
export type MihomoInstallProgress = {
  stage:
    | 'resolving'
    | 'downloading'
    | 'verifying'
    | 'installing'
    | 'starting'
    | 'complete'
    | 'failed'
  version: string
  downloaded_bytes: number
  total_bytes: number | null
  message?: string
}
export function mihomoInstallFeedback(progress: MihomoInstallProgress) {
  const labels = {
    resolving: '正在获取官方稳定版本',
    downloading: '正在下载内核',
    verifying: '正在校验 SHA-256',
    installing: '正在安装并校验配置',
    starting: '正在启动内核并等待监听就绪',
    complete: '安装完成，内核已启动',
    failed: '安装或启动失败',
  }
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + ' MB'
  const percent = progress.total_bytes
    ? Math.min(
        100,
        Math.round((progress.downloaded_bytes / progress.total_bytes) * 100)
      )
    : null
  return {
    label: labels[progress.stage],
    percent,
    bytes:
      mb(progress.downloaded_bytes) +
      (progress.total_bytes ? ' / ' + mb(progress.total_bytes) : ''),
    active: !['complete', 'failed'].includes(progress.stage),
  }
}
export type MihomoStatus = {
  installed: boolean
  running: boolean
  version: string | null
  latest_version: string | null
  external_kernel: boolean
  install_progress: MihomoInstallProgress | null
  busy: boolean
  error: string | null
  download_mode: 'auto' | 'direct' | 'proxy'
  sources: MihomoSource[]
  nodes: MihomoNode[]
}
export function filterMihomoNodes(
  nodes: MihomoNode[],
  filters: { search: string; source: string; state: string; country: string }
) {
  const query = filters.search.trim().toLowerCase()
  return nodes.filter(
    (n) =>
      (!query || n.label.toLowerCase().includes(query)) &&
      (!filters.source || n.source_ids.includes(filters.source)) &&
      (!filters.state || n.enabled === (filters.state === 'enabled')) &&
      (!filters.country || n.check?.geo?.country_code === filters.country)
  )
}
export function selectedMihomoNodes(nodes: MihomoNode[], ids: string[]) {
  const selected = new Set(ids)
  return nodes.filter((n) => selected.has(n.id)).map((n) => n.id)
}

export type CheckProgress = {
  total: number
  completed: number
  succeeded: number
  failed: number
  active: string[]
  cancelled: boolean
}

export async function runMihomoChecks(
  ids: string[],
  check: (id: string) => Promise<{ success: boolean }>,
  options: {
    isCancelled: () => boolean
    onProgress: (progress: CheckProgress) => void
  }
) {
  let cursor = 0
  const progress: CheckProgress = {
    total: ids.length,
    completed: 0,
    succeeded: 0,
    failed: 0,
    active: [],
    cancelled: false,
  }
  const report = () =>
    options.onProgress({ ...progress, active: [...progress.active] })
  report()
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length && !options.isCancelled()) {
        const id = ids[cursor++]
        progress.active.push(id)
        report()
        try {
          const result = await check(id)
          if (result.success) progress.succeeded++
          else progress.failed++
        } catch {
          progress.failed++
        } finally {
          progress.completed++
          progress.active = progress.active.filter((active) => active !== id)
          report()
        }
      }
    })
  )
  progress.cancelled = progress.completed < progress.total
  report()
  return progress
}

export async function applyMihomoBatches(
  ids: string[],
  apply: (ids: string[]) => Promise<unknown>
) {
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100)
    try {
      await apply(batch)
    } catch (error) {
      const message = error instanceof Error ? error.message : '请求失败'
      const failure = new Error(
        '已应用 ' +
          start +
          ' 个；本批 ' +
          batch.length +
          ' 个未确认成功；后续 ' +
          (ids.length - start - batch.length) +
          ' 个未处理。' +
          message
      )
      throw Object.assign(failure, { cause: error })
    }
  }
}
