import { createHash } from 'node:crypto'
import nodeFetch from 'node-fetch'
import { fault } from './config.mjs'

const ARCHES = { x64: 'amd64-compatible', arm64: 'arm64' }
const MAX_DOWNLOAD = 50 * 1024 * 1024
const stableVersion = (version) => /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)

export async function resolveMihomoRelease(
  version = 'latest',
  { arch = process.arch, fetchImpl = nodeFetch, signal } = {},
) {
  if (typeof version !== 'string' || (version !== 'latest' && !stableVersion(version)))
    throw fault('invalid_kernel_version', '版本请填写 latest 或 v开头的稳定版本号，例如 v1.19.32')
  if (!ARCHES[arch]) throw fault('unsupported_platform', '自动安装支持 Linux amd64/arm64', 409)
  const abort = new AbortController()
  let release, response
  try {
    response = await fetchImpl(
      'https://api.github.com/repos/MetaCubeX/mihomo/releases/' + (version === 'latest' ? 'latest' : 'tags/' + version),
      {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
        size: 2 * 1024 * 1024,
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'vm2api-mihomo' },
      },
    )
    signal?.throwIfAborted()
    if (!response.ok) {
      if (response.status === 404) throw fault('kernel_release_missing', '官方未发布该稳定版本，请检查版本号', 404)
      throw new Error('release lookup failed')
    }
    release = await response.json()
  } catch (error) {
    if (signal?.aborted) throw fault('kernel_operation_cancelled', 'Mihomo 内核操作已取消；原内核未改动', 409)
    if (error.code === 'kernel_release_missing') throw error
    throw fault('kernel_release_failed', '无法获取官方版本信息，请稍后重试；原内核未改动', 502)
  } finally {
    abort.abort()
    response?.body?.destroy()
  }
  if (
    !stableVersion(release?.tag_name) ||
    release.draft ||
    release.prerelease ||
    (version !== 'latest' && release.tag_name !== version)
  )
    throw fault('kernel_release_invalid', '只支持官方稳定版内核；原内核未改动', 502)
  const asset = `mihomo-linux-${ARCHES[arch]}-${release.tag_name}.gz`
  const entry = release.assets?.find((item) => item.name === asset)
  if (
    !entry ||
    !/^sha256:[a-f0-9]{64}$/.test(entry.digest || '') ||
    !Number.isSafeInteger(entry.size) ||
    entry.size <= 0 ||
    entry.size > MAX_DOWNLOAD
  )
    throw fault('kernel_release_invalid', '该版本缺少适用的内核文件或官方 SHA-256 校验信息；原内核未改动', 502)
  return { version: release.tag_name, asset, sha256: entry.digest.slice(7), size: entry.size }
}

export async function downloadMihomoRelease(release, { fetchImpl = nodeFetch, onProgress = () => {}, signal } = {}) {
  const progress = { stage: 'downloading', version: release.version, downloaded_bytes: 0, total_bytes: release.size }
  onProgress({ ...progress })
  const abort = new AbortController()
  let bytes, response
  try {
    response = await fetchImpl(
      `https://github.com/MetaCubeX/mihomo/releases/download/${release.version}/${release.asset}`,
      {
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000), ...(signal ? [signal] : [])]),
        size: MAX_DOWNLOAD,
      },
    )
    signal?.throwIfAborted()
    if (!response.ok) throw new Error('download failed')
    const chunks = []
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk)
      progress.downloaded_bytes += buffer.length
      if (progress.downloaded_bytes > MAX_DOWNLOAD || progress.downloaded_bytes > release.size)
        throw new Error('download exceeds release size')
      chunks.push(buffer)
      onProgress({ ...progress })
      signal?.throwIfAborted()
    }
    bytes = Buffer.concat(chunks)
  } catch {
    if (signal?.aborted) throw fault('kernel_operation_cancelled', 'Mihomo 内核操作已取消；原内核未改动', 409)
    throw fault('kernel_download_failed', 'Mihomo 下载失败，请重试；原内核未改动', 502)
  } finally {
    abort.abort()
    response?.body?.destroy()
  }
  onProgress({ ...progress, stage: 'verifying' })
  if (bytes.length !== release.size || createHash('sha256').update(bytes).digest('hex') !== release.sha256)
    throw fault('kernel_checksum_failed', 'Mihomo 校验失败，拒绝安装；原内核未改动', 502)
  return bytes
}
