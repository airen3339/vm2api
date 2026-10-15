import { useEffect, useRef, useState } from 'react'
import { useIsMutating, useMutation, useQuery } from '@tanstack/react-query'
import {
  CheckCircle2,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Square,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  mihomoInstallFeedback,
  applyMihomoBatches,
  runMihomoChecks,
  type CheckProgress,
  type MihomoCheck,
  filterMihomoNodes,
  selectedMihomoNodes,
  type MihomoStatus,
  type MihomoSource,
} from './mihomo-model'
import { useRefreshProxies } from './queries'

type Action = {
  action: string
  id?: string
  ids?: string[]
  label?: string
  url?: string
  text?: string
  mode?: string
  version?: string
}
const selectStyle = 'bg-background h-9 rounded-md border px-2 text-sm'

export function MihomoPanel() {
  const [kernelVersion, setKernelVersion] = useState('latest')
  const activeOperations = useIsMutating({ mutationKey: ['panel', 'mihomo'] })
  const query = useQuery({
    queryKey: ['panel', 'mihomo'],
    queryFn: () => api<MihomoStatus>('/api/panel/mihomo'),
    refetchInterval: (query) =>
      activeOperations || query.state.data?.busy ? 500 : 5000,
  })
  const refreshProxies = useRefreshProxies()
  const [filters, setFilters] = useState({
    search: '',
    source: '',
    state: '',
    country: '',
  })
  const [selected, setSelected] = useState<string[]>([])
  const [page, setPage] = useState(0)
  const [kind, setKind] = useState('subscription')
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [editing, setEditing] = useState<MihomoSource | null>(null)
  const [confirm, setConfirm] = useState<{
    body: Action
    message: string
  } | null>(null)
  const cancelChecks = useRef(false)
  const [progress, setProgress] = useState<CheckProgress | null>(null)
  useEffect(
    () => () => {
      cancelChecks.current = true
    },
    []
  )
  const operation = useMutation({
    mutationKey: ['panel', 'mihomo'],
    mutationFn: async (body: Action) => {
      setConfirm(null)
      setProgress(null)
      if (body.action === 'install') void query.refetch()
      if (['test', 'quality'].includes(body.action)) {
        cancelChecks.current = false
        return runMihomoChecks(
          body.ids || (body.id ? [body.id] : []),
          (id) =>
            api<MihomoCheck>('/api/panel/mihomo', {
              method: 'POST',
              body: JSON.stringify({ action: body.action, id }),
            }),
          { isCancelled: () => cancelChecks.current, onProgress: setProgress }
        )
      }
      if (body.ids?.length) {
        await applyMihomoBatches(body.ids, (ids) =>
          api('/api/panel/mihomo', {
            method: 'POST',
            body: JSON.stringify({ ...body, ids }),
          })
        )
      } else {
        await api('/api/panel/mihomo', {
          method: 'POST',
          body: JSON.stringify(body),
        })
      }
    },
    onSuccess: (result, body) => {
      if (result) {
        const message =
          '已检测 ' +
          result.completed +
          '/' +
          result.total +
          ' 个，成功 ' +
          result.succeeded +
          ' 个，失败 ' +
          result.failed +
          ' 个' +
          (result.cancelled ? '；其余未检测' : '')
        if (result.failed || result.cancelled) toast.warning(message)
        else toast.success(message)
      } else if (body.action === 'install')
        toast.success('内核安装完成并已启动')
      else if (body.action === 'check_update')
        toast.success('已获取官方最新稳定版本')
      else if (body.action === 'start') toast.success('内核已启动')
      else if (body.action === 'stop') toast.success('内核已停止')
      else toast.success('操作已应用')
      setConfirm(null)
      if (
        [
          'source_add',
          'source_update',
          'source_rename',
          'dynamic_add',
        ].includes(body.action)
      ) {
        setContent('')
        setName('')
        setEditing(null)
      }
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: async () => {
      await Promise.all([query.refetch(), refreshProxies()])
    },
  })
  const status = query.data
  const busy = operation.isPending || !!status?.busy || !status
  const installingRequest =
    operation.isPending && operation.variables?.action === 'install'
  const install =
    installingRequest && !status?.busy ? null : status?.install_progress
  const installFeedback = install ? mihomoInstallFeedback(install) : null
  const installing =
    installingRequest || (!!status?.busy && !!installFeedback?.active)
  const rows = filterMihomoNodes(status?.nodes || [], filters)
  const targets = selectedMihomoNodes(rows, selected)
  const selectedIds = new Set(selected)
  const countries = [
    ...new Set(
      (status?.nodes || [])
        .map((n) => n.check?.geo?.country_code)
        .filter((c): c is string => !!c)
    ),
  ].sort()
  const lastPage = Math.max(0, Math.ceil(rows.length / 50) - 1)
  const currentPage = Math.min(page, lastPage)
  const visible = rows.slice(currentPage * 50, currentPage * 50 + 50)
  const selectedOnPage = visible.filter((node) =>
    selectedIds.has(node.id)
  ).length
  const disabledTargets = rows.filter(
    (node) => selectedIds.has(node.id) && !node.enabled
  ).length
  const changeFilter = (key: keyof typeof filters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(0)
  }
  const ask = (body: Action, message: string) => setConfirm({ body, message })
  const editSource = (source: MihomoSource) => {
    setEditing(source)
    setName(source.label)
    setContent('')
    setKind(source.kind)
  }
  const submitSource = () => {
    const action = editing
      ? content.trim()
        ? 'source_update'
        : 'source_rename'
      : kind === 'dynamic'
        ? 'dynamic_add'
        : 'source_add'
    operation.mutate({
      action,
      id: editing?.id,
      label: name,
      ...(kind === 'dynamic' ? { text: content } : { url: content }),
    })
  }

  return (
    <section
      className='space-y-5 rounded-xl border p-4 sm:p-6'
      aria-label='Mihomo 管理'
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h2 className='text-lg font-semibold'>Mihomo 订阅与节点</h2>
          <p className='mt-1 text-sm text-muted-foreground'>
            独立节点出口，接入现有代理池；不自动换节点或回退直连。
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-sm' role='status'>
            {query.isPending
              ? '正在加载状态'
              : !status
                ? '状态加载失败'
                : installing
                  ? '正在安装并启动'
                  : status.running
                    ? '内核运行中'
                    : status?.installed
                      ? '内核已停止'
                      : '尚未安装内核'}
          </span>
          {status?.running ? (
            <Button
              size='sm'
              variant='outline'
              disabled={busy}
              onClick={() =>
                ask(
                  { action: 'stop' },
                  '停止内核会中断所有 Mihomo 出口；现有绑定会保留，不会切换为直连。'
                )
              }
            >
              <Square aria-hidden='true' />
              停止
            </Button>
          ) : (
            <Button
              size='sm'
              disabled={busy || !status?.installed}
              onClick={() => operation.mutate({ action: 'start' })}
            >
              <Play aria-hidden='true' />
              启动
            </Button>
          )}
          <Button
            size='icon'
            variant='ghost'
            aria-label='刷新 Mihomo 状态'
            onClick={() => void query.refetch()}
          >
            <RefreshCw aria-hidden='true' />
          </Button>
        </div>
      </div>
      <div className='space-y-3 rounded-lg border bg-muted/30 p-3'>
        <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-sm'>
          <span>
            当前内核：
            <strong>
              {!status
                ? '正在读取'
                : status.installed
                  ? status.version || '版本未知'
                  : '未安装'}
            </strong>
          </span>
          <span className='text-muted-foreground'>
            最新稳定版：{status?.latest_version || '尚未检查'}
          </span>
          <Button
            size='sm'
            variant='ghost'
            disabled={busy}
            onClick={() => operation.mutate({ action: 'check_update' })}
          >
            <RefreshCw
              className={
                operation.isPending &&
                operation.variables?.action === 'check_update'
                  ? 'animate-spin motion-reduce:animate-none'
                  : ''
              }
              aria-hidden='true'
            />
            {operation.isPending &&
            operation.variables?.action === 'check_update'
              ? '正在检查'
              : '检查更新'}
          </Button>
        </div>
        {status?.external_kernel ? (
          <p className='text-sm text-muted-foreground'>
            内核由服务器配置 KIN_MIHOMO_BIN 管理，请通过部署配置更新。
          </p>
        ) : (
          <div className='flex flex-wrap items-end gap-2'>
            <label className='flex flex-col gap-1 text-sm'>
              安装版本
              <Input
                aria-label='安装版本'
                className='w-44'
                placeholder='latest 或 v1.19.32'
                value={kernelVersion}
                disabled={busy || !!status?.running}
                onChange={(event) => setKernelVersion(event.target.value)}
              />
            </label>
            <Button
              size='sm'
              disabled={busy || !!status?.running || !kernelVersion.trim()}
              onClick={() =>
                operation.mutate({
                  action: 'install',
                  version: kernelVersion.trim(),
                })
              }
            >
              {installing ? (
                <Loader2
                  className='animate-spin motion-reduce:animate-none'
                  aria-hidden='true'
                />
              ) : (
                <Download aria-hidden='true' />
              )}
              {installing
                ? '正在安装并启动'
                : status?.installed
                  ? '更新并启动'
                  : '安装并启动'}
            </Button>
            <p className='pb-1 text-xs text-muted-foreground'>
              {status?.running
                ? '更新前先停止内核。'
                : 'latest 获取官方最新稳定版；安装成功后自动启动。'}
            </p>
          </div>
        )}
        {(installing || install) && (
          <div
            className='space-y-2 rounded-md border bg-background p-3'
            role={install?.stage === 'failed' ? 'alert' : 'status'}
            aria-live='polite'
          >
            <div className='flex items-center gap-2 text-sm'>
              {installing ? (
                <Loader2
                  className='size-4 animate-spin motion-reduce:animate-none'
                  aria-hidden='true'
                />
              ) : install?.stage === 'complete' ? (
                <CheckCircle2
                  className='size-4 text-green-600'
                  aria-hidden='true'
                />
              ) : (
                <XCircle
                  className='size-4 text-destructive'
                  aria-hidden='true'
                />
              )}
              <span>
                {installing && !installFeedback?.active
                  ? '正在准备安装'
                  : installFeedback?.label || '正在准备安装'}
                {install?.version && install.version !== 'latest'
                  ? ' · ' + install.version
                  : ''}
              </span>
            </div>
            {install?.stage === 'downloading' && installFeedback && (
              <>
                <progress
                  className='h-2 w-full accent-primary'
                  aria-label='内核下载进度'
                  max={100}
                  value={installFeedback.percent ?? undefined}
                />
                <p className='text-xs text-muted-foreground'>
                  {installFeedback.bytes}
                  {installFeedback.percent !== null
                    ? '（' + installFeedback.percent + '%）'
                    : ''}
                </p>
              </>
            )}
            {install?.message && (
              <p className='text-sm text-destructive'>{install.message}</p>
            )}
          </div>
        )}
      </div>
      {query.error && (
        <p role='alert' className='text-sm text-destructive'>
          {query.error.message}
        </p>
      )}
      {status?.error && status.error !== install?.message && (
        <p role='alert' className='text-sm text-destructive'>
          {status.error}
        </p>
      )}
      {operation.isPending &&
        !progress &&
        operation.variables?.action !== 'install' && (
          <p role='status' className='flex items-center gap-2 text-sm'>
            <Loader2
              className='size-4 animate-spin motion-reduce:animate-none'
              aria-hidden='true'
            />
            正在应用操作…
          </p>
        )}
      {progress && (
        <div
          className='flex flex-wrap items-center gap-3 text-sm'
          role='status'
          aria-live='polite'
        >
          <span>
            已检测 {progress.completed}/{progress.total}；成功{' '}
            {progress.succeeded}，失败 {progress.failed}
            {progress.cancelled ? '；其余未检测' : ''}
          </span>
          {!!progress.active.length && (
            <span className='text-muted-foreground'>
              正在检测：
              {progress.active
                .map(
                  (id) => status?.nodes.find((n) => n.id === id)?.label || id
                )
                .join('、')}
            </span>
          )}
          {operation.isPending && (
            <Button
              size='sm'
              variant='outline'
              onClick={() => {
                cancelChecks.current = true
              }}
            >
              停止后续检测
            </Button>
          )}
        </div>
      )}
      <div className='grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]'>
        <div className='space-y-3'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <h3 className='font-medium'>订阅与动态代理来源</h3>
            <label className='flex items-center gap-2 text-sm'>
              订阅下载
              <select
                className={selectStyle}
                value={status?.download_mode || 'auto'}
                disabled={busy || !status}
                onChange={(e) =>
                  operation.mutate({
                    action: 'download_mode',
                    mode: e.target.value,
                  })
                }
              >
                <option value='auto'>自动：代理失败后直连</option>
                <option value='proxy'>仅代理，不回退直连</option>
                <option value='direct'>仅直连</option>
              </select>
            </label>
          </div>
          <p className='text-xs text-muted-foreground'>
            下载模式仅影响订阅获取，不影响账号请求；自动模式的直连回退可能向订阅提供方暴露服务器
            IP。
          </p>
          {status && !status.sources.length && (
            <p className='rounded-md border border-dashed p-5 text-sm text-muted-foreground'>
              安装内核后添加 Clash/Mihomo YAML 订阅，或导入 HTTP(S)/SOCKS5
              动态代理。
            </p>
          )}
          {status?.sources.map((s) => (
            <div
              key={s.id}
              className='flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3'
            >
              <div className='min-w-0'>
                <p className='text-sm font-medium break-all'>{s.label}</p>
                <p className='text-xs text-muted-foreground'>
                  {s.kind === 'dynamic' ? '动态代理' : '订阅'} · {s.nodes}{' '}
                  个节点 · {s.enabled ? '已启用' : '已停用'}
                  <span className='block'>
                    更新于 {new Date(s.updated_at).toLocaleString()}
                  </span>
                </p>
              </div>
              <div className='flex flex-wrap gap-1'>
                <Button
                  size='sm'
                  variant='ghost'
                  disabled={busy}
                  onClick={() => editSource(s)}
                >
                  编辑
                </Button>
                {s.kind === 'subscription' && (
                  <Button
                    size='sm'
                    variant='ghost'
                    disabled={busy}
                    onClick={() =>
                      operation.mutate({ action: 'source_refresh', id: s.id })
                    }
                  >
                    刷新
                  </Button>
                )}
                <Button
                  size='sm'
                  variant='ghost'
                  disabled={busy}
                  onClick={() =>
                    s.enabled
                      ? ask(
                          { action: 'source_disable', id: s.id },
                          '停用该来源的专属节点会拒绝已有绑定的流量；其他来源共有的节点保留。'
                        )
                      : operation.mutate({ action: 'source_enable', id: s.id })
                  }
                >
                  {s.enabled ? '停用' : '启用'}
                </Button>
                <Button
                  size='sm'
                  variant='ghost'
                  disabled={busy}
                  onClick={() =>
                    ask(
                      { action: 'source_remove', id: s.id },
                      '删除此来源及其专属节点？旧代理端口不会改指其他节点；其他来源不受影响。'
                    )
                  }
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
        </div>
        <form
          className='space-y-3 rounded-lg border p-4'
          onSubmit={(e) => {
            e.preventDefault()
            submitSource()
          }}
        >
          <fieldset disabled={busy} className='space-y-3'>
            <h3 className='font-medium'>{editing ? '编辑来源' : '添加来源'}</h3>
            {!editing && (
              <select
                aria-label='来源类型'
                className={`${selectStyle} w-full`}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value)
                  setContent('')
                }}
              >
                <option value='subscription'>Clash/Mihomo 订阅</option>
                <option value='dynamic'>HTTP(S)/SOCKS5 动态代理</option>
              </select>
            )}
            <label className='block space-y-1 text-sm'>
              <span>名称</span>
              <Input
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                placeholder='例如：主用订阅'
              />
            </label>
            {(!editing || kind === 'subscription') && (
              <label className='block space-y-1 text-sm'>
                <span>
                  {kind === 'subscription' ? '订阅地址' : '代理地址，每行一个'}
                </span>
                {kind === 'subscription' ? (
                  <Input
                    type='password'
                    autoComplete='off'
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={editing ? '留空仅修改名称' : 'https://…'}
                  />
                ) : (
                  <Textarea
                    autoComplete='off'
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder='socks5://用户:密码@主机:端口#名称'
                  />
                )}
              </label>
            )}
            <p className='text-xs text-muted-foreground'>
              地址和凭据不在列表回显；动态代理固定供应商配置，不保证公网 IP
              不变。
            </p>
            <div className='flex gap-2'>
              <Button
                type='submit'
                disabled={
                  busy || !status?.installed || (!editing && !content.trim())
                }
              >
                {editing ? '保存' : '添加'}
              </Button>
              {editing && (
                <Button
                  type='button'
                  variant='ghost'
                  onClick={() => {
                    setEditing(null)
                    setName('')
                    setContent('')
                  }}
                >
                  取消
                </Button>
              )}
            </div>
          </fieldset>
        </form>
      </div>
      <div className='space-y-3 border-t pt-5'>
        <h3 className='font-medium'>
          节点{' '}
          <span className='text-sm font-normal text-muted-foreground'>
            {rows.length} 个，已选择当前筛选内 {targets.length} 个
          </span>
        </h3>
        <div className='flex flex-wrap gap-2'>
          <Input
            className='w-full sm:w-60'
            aria-label='搜索节点'
            placeholder='搜索节点名称'
            value={filters.search}
            onChange={(e) => changeFilter('search', e.target.value)}
          />
          <select
            className={selectStyle}
            aria-label='按来源筛选'
            value={filters.source}
            onChange={(e) => changeFilter('source', e.target.value)}
          >
            <option value=''>全部来源</option>
            {status?.sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            className={selectStyle}
            aria-label='按状态筛选'
            value={filters.state}
            onChange={(e) => changeFilter('state', e.target.value)}
          >
            <option value=''>全部状态</option>
            <option value='enabled'>已启用</option>
            <option value='disabled'>已停用</option>
          </select>
          <select
            className={selectStyle}
            aria-label='按实测地区筛选'
            value={filters.country}
            onChange={(e) => changeFilter('country', e.target.value)}
          >
            <option value=''>全部实测地区</option>
            {countries.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className='flex flex-wrap gap-2'>
          <Button
            size='sm'
            variant='outline'
            disabled={!rows.length}
            onClick={() => setSelected(rows.map((node) => node.id))}
          >
            选择全部筛选结果（{rows.length}）
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={!selected.length}
            onClick={() => setSelected([])}
          >
            清空选择
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={busy || !targets.length}
            onClick={() => operation.mutate({ action: 'test', ids: targets })}
          >
            测试所选连接
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={busy || !targets.length}
            onClick={() =>
              operation.mutate({ action: 'quality', ids: targets })
            }
          >
            检测所选网络质量
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={busy || !targets.length}
            onClick={() =>
              operation.mutate({ action: 'node_enable', ids: targets })
            }
          >
            启用所选
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={busy || !targets.length}
            onClick={() =>
              ask(
                { action: 'node_disable', ids: targets },
                '停用所选节点会拒绝其已有代理绑定的流量，不自动切换出口。'
              )
            }
          >
            停用所选
          </Button>
          <Button
            size='sm'
            disabled={
              busy || !targets.length || !!disabledTargets || !status?.running
            }
            onClick={() =>
              ask(
                { action: 'node_export', ids: targets },
                '将所选节点加入下方代理池，然后绑定到本机槽位；动态代理的公网 IP 仍由供应商决定。'
              )
            }
          >
            添加所选到代理池
          </Button>
        </div>
        {!!disabledTargets && (
          <p className='text-sm text-muted-foreground'>
            所选有 {disabledTargets}{' '}
            个停用节点，加入代理池前请先启用或取消选择。
          </p>
        )}
        <p className='text-xs text-muted-foreground'>
          检测使用独立内核，不切换业务出口；质量结果仅代表常见 HTTPS
          站点连通性，不代表模型可用或 IP 风险等级。
        </p>
        <div className='overflow-x-auto rounded-lg border'>
          <table className='w-full text-left text-sm'>
            <thead className='bg-muted/40'>
              <tr>
                <th className='w-10 p-3'>
                  <input
                    type='checkbox'
                    aria-label='选择本页节点'
                    checked={
                      !!visible.length && selectedOnPage === visible.length
                    }
                    ref={(input) => {
                      if (input)
                        input.indeterminate =
                          selectedOnPage > 0 && selectedOnPage < visible.length
                    }}
                    disabled={!visible.length}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [
                              ...new Set([
                                ...selected,
                                ...visible.map((n) => n.id),
                              ]),
                            ]
                          : selected.filter(
                              (id) => !visible.some((n) => n.id === id)
                            )
                      )
                    }
                  />
                </th>
                <th className='p-3'>节点</th>
                <th className='p-3'>状态</th>
                <th className='p-3'>实测出口</th>
                <th className='p-3'>连接 / 质量</th>
                <th className='p-3'>操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((n) => (
                <tr key={n.id} className='border-t'>
                  <td className='p-3'>
                    <input
                      type='checkbox'
                      aria-label={`选择 ${n.label}`}
                      checked={selectedIds.has(n.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, n.id]
                            : selected.filter((id) => id !== n.id)
                        )
                      }
                    />
                  </td>
                  <td className='max-w-xs p-3'>
                    <p className='font-medium break-all'>{n.label}</p>
                    <p className='text-xs text-muted-foreground'>
                      {n.type}
                      {n.dynamic ? ' · 动态 IP' : ''}
                      {n.proxy_id ? ' · 已加入代理池' : ''}
                    </p>
                  </td>
                  <td className='p-3 whitespace-nowrap'>
                    {n.enabled ? '节点已启用' : '节点已停用'}
                    {n.outlet && (
                      <p className='text-xs text-muted-foreground'>
                        {n.outlet.enabled
                          ? n.outlet.status === 'ok'
                            ? '出口正常'
                            : '出口待检测'
                          : '出口不可用'}{' '}
                        · {n.outlet.bound_count} 个绑定槽位
                      </p>
                    )}
                    {n.outlet?.error && (
                      <p className='text-xs text-destructive'>
                        {n.outlet.error === 'mihomo_unavailable'
                          ? '内核、来源或出口已停用'
                          : '出口检测异常，请重新检测'}
                      </p>
                    )}
                  </td>
                  <td className='p-3'>
                    {n.check?.geo?.ip || (n.check ? '本次未获取' : '未检测')}
                    <p className='text-xs text-muted-foreground'>
                      {n.check?.geo?.country || ''}
                    </p>
                  </td>
                  <td className='p-3 whitespace-nowrap'>
                    {n.check
                      ? n.check.success
                        ? `${n.check.latency_ms} ms`
                        : '连接失败'
                      : '未检测'}
                    {n.check?.checked_at && (
                      <p className='text-xs text-muted-foreground'>
                        {new Date(n.check.checked_at).toLocaleString()}
                      </p>
                    )}
                    {n.check?.quality && (
                      <p className='text-xs text-muted-foreground'>
                        {n.check.quality.passed}/{n.check.quality.total}{' '}
                        站点通过
                      </p>
                    )}
                  </td>
                  <td className='p-3'>
                    <div className='flex gap-1'>
                      <Button
                        size='sm'
                        variant='ghost'
                        disabled={busy}
                        onClick={() =>
                          operation.mutate({ action: 'test', id: n.id })
                        }
                      >
                        检测
                      </Button>
                      {n.proxy_id && (
                        <Button
                          size='sm'
                          variant='ghost'
                          disabled={busy}
                          onClick={() =>
                            ask(
                              { action: 'node_unexport', id: n.id },
                              '从代理池移除此节点？已绑定槽位的节点需先解除绑定，原端口不会分配给其他节点。'
                            )
                          }
                        >
                          移出代理池
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && (
            <p className='p-6 text-center text-sm text-muted-foreground'>
              没有匹配的节点
            </p>
          )}
        </div>
        <div className='flex items-center justify-end gap-3 text-sm'>
          <span>
            {currentPage + 1} / {lastPage + 1}
          </span>
          <Button
            size='sm'
            variant='outline'
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={currentPage === lastPage}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null)
        }}
        title='确认代理操作'
        desc={confirm?.message || ''}
        confirmText='确认'
        cancelBtnText='取消'
        isLoading={busy}
        handleConfirm={() => {
          if (confirm) operation.mutate(confirm.body)
        }}
      />
    </section>
  )
}
