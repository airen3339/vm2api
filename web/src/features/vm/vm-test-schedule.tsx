import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { CircleHelp, Clock3, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'

type TestSchedule = {
  enabled: boolean
  cron: string
  timezone: string
  model: string
  prompt: string
  max_tokens: number | null
  reasoning_effort: string | null
  last_run_at: string | null
  last_ok: boolean | null
  last_duration_ms: number | null
  last_error: string | null
  next_run_at: string | null
  running: boolean
}

type SchedulePayload = { schedule: TestSchedule | null }

type TestParams = {
  vm: Vm
  models: { id: string }[]
  model: string
  prompt: string
  maxTokens: number
  reasoningEffort: string
  onPromptChange: (value: string) => void
  onLoadSchedule: (schedule: TestSchedule) => void
}

const DEFAULT_CRON = '0 9 * * *'

function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function formatAt(value: string | null, timezone: string) {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value))
  } catch {
    return value
  }
}

export function VmTestSchedule({
  vm,
  models,
  model,
  prompt,
  maxTokens,
  reasoningEffort,
  onPromptChange,
  onLoadSchedule,
}: TestParams) {
  const codex = isCodexVm(vm)
  const qc = useQueryClient()
  const queryKey = ['panel', 'vm', vm.id, 'test-schedule'] as const
  const endpoint = `/api/panel/vms/${encodeURIComponent(vm.id)}/test-schedule`
  const loaded = useRef(false)
  const [enabled, setEnabled] = useState(false)
  const [cron, setCron] = useState(DEFAULT_CRON)
  const [timezone, setTimezone] = useState(localTimezone)
  const scheduleQuery = useQuery({
    queryKey,
    queryFn: ({ queryKey: key, signal }) =>
      api<SchedulePayload>(
        `/api/panel/vms/${encodeURIComponent(key[2])}/test-schedule`,
        { signal }
      ),
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.schedule?.enabled ? 30_000 : false,
  })
  const saved = scheduleQuery.data?.schedule || null

  useEffect(() => {
    if (loaded.current || !scheduleQuery.data) return
    loaded.current = true
    const schedule = scheduleQuery.data.schedule
    if (!schedule) return
    setEnabled(schedule.enabled)
    setCron(schedule.cron)
    setTimezone(schedule.timezone)
    onLoadSchedule(schedule)
  }, [onLoadSchedule, scheduleQuery.data])

  const selectedModel = model || models[0]?.id || ''
  const dirty = saved
    ? enabled !== saved.enabled ||
      cron.trim() !== saved.cron ||
      selectedModel !== saved.model ||
      prompt.trim() !== saved.prompt ||
      (codex
        ? reasoningEffort !== saved.reasoning_effort
        : maxTokens !== saved.max_tokens)
    : enabled || cron.trim() !== DEFAULT_CRON

  const save = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey }),
    mutationFn: () =>
      api<SchedulePayload>(endpoint, {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          cron: cron.trim(),
          timezone,
          model: selectedModel,
          prompt,
          ...(codex
            ? { reasoning_effort: reasoningEffort }
            : { max_tokens: maxTokens }),
        }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data)
      if (data.schedule) {
        setEnabled(data.schedule.enabled)
        setCron(data.schedule.cron)
        setTimezone(data.schedule.timezone)
        onPromptChange(data.schedule.prompt)
      }
      toast.success(
        data.schedule?.enabled ? '定时测试已启用' : '测试计划已保存'
      )
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  })
  const remove = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey }),
    mutationFn: () => api<SchedulePayload>(endpoint, { method: 'DELETE' }),
    onSuccess: (data) => {
      qc.setQueryData(queryKey, data)
      setEnabled(false)
      setCron(DEFAULT_CRON)
      setTimezone(localTimezone())
      toast.success('测试计划已删除')
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  })
  const busy = save.isPending || remove.isPending

  return (
    <section className='space-y-3 border-t pt-3'>
      <div className='flex items-center justify-between gap-3'>
        <h3 className='flex items-center gap-1.5 text-sm font-medium'>
          <Clock3 className='size-4' /> 定时测试
        </h3>
        <div className='flex items-center gap-2'>
          {dirty && loaded.current ? (
            <span className='text-xs text-muted-foreground'>未保存</span>
          ) : null}
          <Switch
            aria-label='启用定时测试'
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={scheduleQuery.isPending || scheduleQuery.isError || busy}
          />
        </div>
      </div>

      {scheduleQuery.isPending ? (
        <p className='text-xs text-muted-foreground'>正在读取计划…</p>
      ) : scheduleQuery.isError ? (
        <div className='flex items-center gap-2 text-xs text-destructive'>
          <span role='alert'>计划读取失败：{scheduleQuery.error.message}</span>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => void scheduleQuery.refetch()}
          >
            重试
          </Button>
        </div>
      ) : (
        <>
          <div className='space-y-1.5'>
            <div className='flex items-center gap-1'>
              <Label htmlFor={`vm-test-cron-${vm.id}`}>Cron 表达式</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type='button'
                    size='icon'
                    variant='ghost'
                    className='size-6 text-muted-foreground'
                    aria-label='Cron 表达式示例'
                    title='Cron 表达式示例'
                  >
                    <CircleHelp className='size-4' />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align='start'
                  side='top'
                  collisionPadding={16}
                  className='max-h-[min(70dvh,26rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto p-3 text-xs leading-5'
                >
                  <p className='font-medium'>Cron 表达式示例</p>
                  <p className='mt-1 text-muted-foreground'>
                    标准 5 字段：分钟 小时 日 月 星期
                  </p>
                  <div className='mt-3 grid grid-cols-[7.5rem_1fr] gap-x-2 gap-y-2'>
                    <code>*/30 * * * *</code>
                    <span>每 30 分钟</span>
                    <code>0 * * * *</code>
                    <span>每小时整点</span>
                    <code>0 9 * * *</code>
                    <span>每天 09:00</span>
                    <code>0 9 * * 1</code>
                    <span>每周一 09:00</span>
                  </div>
                  <p className='mt-3 border-t pt-2 text-muted-foreground'>
                    按 {timezone}{' '}
                    时区运行。真实测试会消耗模型额度，建议先从每天一次开始。
                  </p>
                </PopoverContent>
              </Popover>
            </div>
            <Input
              id={`vm-test-cron-${vm.id}`}
              className='font-mono'
              value={cron}
              onChange={(event) => setCron(event.target.value)}
              maxLength={120}
              autoComplete='off'
              spellCheck={false}
            />
            <p className='text-xs text-muted-foreground'>
              {timezone} · 真实调用会消耗额度
            </p>
          </div>
          <div className='flex items-center gap-2'>
            <Button
              size='sm'
              onClick={() => save.mutate()}
              disabled={
                busy || !selectedModel || !prompt.trim() || !cron.trim()
              }
              loading={save.isPending}
            >
              <Save /> 保存计划
            </Button>
            {saved ? (
              <Button
                size='icon'
                variant='ghost'
                className='size-8 text-muted-foreground'
                aria-label='删除定时测试'
                title='删除定时测试'
                onClick={() => remove.mutate()}
                disabled={busy}
              >
                <Trash2 />
              </Button>
            ) : null}
          </div>
          {saved ? (
            <div className='space-y-1 text-xs text-muted-foreground'>
              <p>
                当前计划：{saved.enabled ? '启用' : '暂停'} · {saved.model}
                {saved.running ? ' · 运行中' : ''}
              </p>
              <p>下次运行：{formatAt(saved.next_run_at, saved.timezone)}</p>
              <p>
                上次运行：{formatAt(saved.last_run_at, saved.timezone)}
                {saved.last_ok != null
                  ? ` · ${saved.last_ok ? '成功' : '失败'}`
                  : ''}
                {saved.last_duration_ms != null
                  ? ` · ${saved.last_duration_ms}ms`
                  : ''}
              </p>
              {saved.last_error ? (
                <p className='break-words text-destructive'>
                  {saved.last_error}
                </p>
              ) : null}
            </div>
          ) : (
            <p className='text-xs text-muted-foreground'>尚未创建计划</p>
          )}
        </>
      )}
    </section>
  )
}
