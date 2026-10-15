import { describe, expect, it } from 'vitest'
import {
  mihomoInstallFeedback,
  applyMihomoBatches,
  runMihomoChecks,
  filterMihomoNodes,
  selectedMihomoNodes,
  type MihomoNode,
} from './mihomo-model'

const node = (id: string, enabled = true): MihomoNode => ({
  id,
  label: id,
  type: 'ss',
  enabled,
  dynamic: false,
  source_ids: ['source1'],
  proxy_id: null,
  check: null,
})
describe('Mihomo node selection', () => {
  it('requires explicit selection and limits batch operations to the current filter', () => {
    const rows = [node('JP'), node('US')]
    expect(selectedMihomoNodes(rows, [])).toEqual([])
    expect(selectedMihomoNodes([rows[0]], ['JP', 'US', 'removed'])).toEqual([
      'JP',
    ])
  })
  it('combines source, enabled status, actual country and case-insensitive name', () => {
    const nodes = [node('Japan'), node('US', false)]
    nodes[0].check = {
      success: true,
      latency_ms: 10,
      geo: { country_code: 'JP' },
    }
    expect(
      filterMihomoNodes(nodes, {
        search: 'jap',
        source: 'source1',
        state: 'enabled',
        country: 'JP',
      }).map((n) => n.id)
    ).toEqual(['Japan'])
    expect(
      filterMihomoNodes(nodes, {
        search: '',
        source: '',
        state: 'disabled',
        country: '',
      }).map((n) => n.id)
    ).toEqual(['US'])
  })
})

describe('Mihomo batch operations', () => {
  it('limits checks to four concurrent requests and counts unsuccessful responses', async () => {
    let active = 0
    let peak = 0
    const result = await runMihomoChecks(
      Array.from({ length: 10 }, (_, i) => String(i)),
      async (id) => {
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        active--
        if (id === '1') throw new Error('network')
        return { success: id !== '2' }
      },
      { isCancelled: () => false, onProgress: () => {} }
    )
    expect(peak).toBe(4)
    expect(result).toMatchObject({
      completed: 10,
      succeeded: 8,
      failed: 2,
      cancelled: false,
      active: [],
    })
  })
  it('cancels pending checks while allowing in-flight checks to finish', async () => {
    let cancelled = false
    const seen: string[] = []
    const result = await runMihomoChecks(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      async (id) => {
        seen.push(id)
        await Promise.resolve()
        cancelled = true
        return { success: true }
      },
      { isCancelled: () => cancelled, onProgress: () => {} }
    )
    expect(seen).toEqual(['a', 'b', 'c', 'd'])
    expect(result).toMatchObject({ completed: 4, total: 6, cancelled: true })
  })
  it('reports confirmed changes, an uncertain failed batch and untouched targets', async () => {
    let calls = 0
    await expect(
      applyMihomoBatches(
        Array.from({ length: 250 }, (_, i) => String(i)),
        async () => {
          if (++calls === 2) throw new Error('timeout')
        }
      )
    ).rejects.toThrow('已应用 100 个；本批 100 个未确认成功；后续 50 个未处理')
    expect(calls).toBe(2)
  })
})

describe('Mihomo installation feedback', () => {
  it('shows actual downloaded bytes and determinate or indeterminate progress', () => {
    const progress = {
      stage: 'downloading' as const,
      version: 'v1.20.1',
      downloaded_bytes: 5 * 1024 * 1024,
      total_bytes: 20 * 1024 * 1024,
    }
    expect(mihomoInstallFeedback(progress)).toEqual({
      label: '正在下载内核',
      percent: 25,
      bytes: '5.0 MB / 20.0 MB',
      active: true,
    })
    expect(
      mihomoInstallFeedback({ ...progress, total_bytes: null }).percent
    ).toBeNull()
  })
  it('distinguishes startup from successful completion and failure', () => {
    const progress = {
      version: 'latest',
      downloaded_bytes: 0,
      total_bytes: null,
    }
    expect(
      mihomoInstallFeedback({ ...progress, stage: 'starting' }).label
    ).toContain('等待监听就绪')
    expect(
      mihomoInstallFeedback({ ...progress, stage: 'complete' })
    ).toMatchObject({ label: '安装完成，内核已启动', active: false })
    expect(mihomoInstallFeedback({ ...progress, stage: 'failed' }).active).toBe(
      false
    )
  })
})
