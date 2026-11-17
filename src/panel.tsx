// The Session Progress sidebar panel. The worker reads agent session files; this file only draws.
import {
  atom,
  Badge,
  Box,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Progress,
  Row,
  Separator,
  Spinner,
  Stack,
  Text,
  plugin,
  read,
  set,
  type PanelContext
} from 'orca'
import type { ProgressSnapshot, ProgressTask, SessionProgress } from './protocol'

const REFRESH_MS = 3_000

const data = atom<ProgressSnapshot | null>(null)
const loading = atom<boolean>('loading', true)
/** The todo list and recent actions fold away, like omp's ctrl+q. */
const folded = atom<boolean>('folded', false, { persist: 'plugin' })

async function refresh(): Promise<void> {
  try {
    set(data, await plugin.request('progress.get'))
  } catch {
    // Keep the last good snapshot; the next tick tries again.
  } finally {
    set(loading, false)
  }
}

export function setup(ctx: PanelContext): void {
  void refresh()
  const timer = setInterval(() => void refresh(), REFRESH_MS)
  // A panel test has no Orca loop to keep alive.
  if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ''}`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

function elapsed(session: SessionProgress): string | null {
  const start = session.turnStartedAt ?? session.startedAt
  if (!start) return null
  const end = session.state === 'working' ? Date.now() : (session.lastAt ?? session.updatedAt)
  return formatDuration(Math.max(0, end - start))
}

const STATE_TEXT: Record<NonNullable<SessionProgress['state']>, string> = {
  working: '进行中',
  blocked: '需要你',
  waiting: '等待你',
  done: '已完成'
}

const AGENT_NAME: Record<string, string> = {
  omp: 'omp',
  pi: 'pi',
  claude: 'Claude',
  codex: 'Codex'
}

function glyph(status: ProgressTask['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '●'
  if (status === 'abandoned') return '⊘'
  return '○'
}

function TaskRow({ task, last }: { task: ProgressTask; last: boolean }) {
  const active = task.status === 'in_progress'
  const done = task.status === 'completed' || task.status === 'abandoned'
  return (
    <Row gap="xs" align="start">
      <Text size="xs" muted>
        {last ? '└─' : '├─'}
      </Text>
      <Box grow paddingX="xs" radius="sm" background={active ? 'muted' : 'none'}>
        <Row gap="xs" align="start">
          <Text size="sm" tone={active ? 'accent' : undefined} muted={!active && done}>
            {glyph(task.status)}
          </Text>
          <Box grow>
            <Text
              size="sm"
              tone={active ? 'accent' : undefined}
              muted={!active && done}
              weight={active ? 'semibold' : 'regular'}
            >
              {task.content}
            </Text>
          </Box>
        </Row>
      </Box>
    </Row>
  )
}

function PhaseTree({ session }: { session: SessionProgress }) {
  if (session.phases.length === 0) {
    return (
      <Text size="sm" muted>
        这个会话还没有 todo 计划。
      </Text>
    )
  }
  return (
    <Stack gap="xs">
      {session.phases.map((phase, index) => {
        const done = phase.tasks.filter((task) => task.status === 'completed').length
        const current = session.currentPhase === phase.name
        return (
          <Stack key={`${index}-${phase.name}`} gap="xs">
            <Row justify="between" align="center">
              <Row gap="xs" align="center">
                <Text size="xs" weight={current ? 'medium' : 'regular'} tone={current ? 'accent' : undefined} muted={!current}>
                  {phase.name}
                </Text>
                {current ? <Badge tone="accent">当前</Badge> : null}
              </Row>
              <Text size="xs" muted>
                {done}/{phase.tasks.length}
              </Text>
            </Row>
            <Stack gap="none">
              {phase.tasks.map((task, taskIndex) => (
                <TaskRow key={`${taskIndex}-${task.content}`} task={task} last={taskIndex === phase.tasks.length - 1} />
              ))}
            </Stack>
          </Stack>
        )
      })}
    </Stack>
  )
}

function MainSession({ session }: { session: SessionProgress }) {
  const percent = session.total > 0 ? session.done / session.total : 0
  const duration = elapsed(session)
  const isFolded = read(folded)
  return (
    <Box padding="md" radius="lg" border background="card">
      <Stack gap="sm">
        <Row justify="between" align="center">
          <Row gap="xs" align="center" wrap>
            {session.state === 'working' ? (
              <Spinner label="进行中" labelHidden />
            ) : (
              <Text size="sm" tone={session.state === 'done' ? 'success' : undefined} muted={session.state !== 'done'}>
                ●
              </Text>
            )}
            <Text size="sm" weight="semibold">
              {session.state ? STATE_TEXT[session.state] : '最近活动'}
            </Text>
            {duration ? (
              <Text size="xs" muted>
                · {duration}
              </Text>
            ) : null}
            {session.contextTokens + session.turnOutputTokens > 0 ? (
              <Text size="xs" muted>
                · ↑{compact(session.contextTokens)} ↓{compact(session.turnOutputTokens)}
              </Text>
            ) : null}
          </Row>
          <IconButton
            icon={isFolded ? 'expand' : 'collapse'}
            label={isFolded ? '展开任务列表' : '折叠任务列表'}
            tooltip={isFolded ? '展开' : '折叠'}
            variant="ghost"
            size="sm"
            onPress={() => set(folded, !isFolded)}
          />
        </Row>

        {session.goal ? (
          <Text size="sm" weight="medium" truncate>
            {session.goal}
          </Text>
        ) : null}

        {session.total > 0 ? (
          <Stack gap="xs">
            <Row justify="between">
              <Text size="xs" muted>
                {session.done}/{session.total} 完成
              </Text>
              <Text size="xs" muted>
                {Math.round(percent * 100)}%
              </Text>
            </Row>
            <Progress label="会话进度" labelHidden value={percent} />
          </Stack>
        ) : null}

        {isFolded ? (
          session.current ? (
            <Text size="sm" tone="accent" truncate>
              当前：{session.currentPhase ? `${session.currentPhase} · ` : ''}
              {session.current}
            </Text>
          ) : null
        ) : (
          <>
            <PhaseTree session={session} />
            {session.recent.length > 0 ? (
              <>
                <Separator />
                <Stack gap="xs">
                  <Text size="xs" muted>
                    最近动作
                  </Text>
                  {session.recent.map((action, index) => (
                    <Text key={`${index}-${action}`} size="xs" muted truncate>
                      · {action}
                    </Text>
                  ))}
                </Stack>
              </>
            ) : session.lastActivity ? (
              <Text size="xs" muted truncate>
                最近：{session.lastActivity}
              </Text>
            ) : null}
          </>
        )}

        <Row justify="between" align="center">
          <Text size="xs" muted>
            {AGENT_NAME[session.agent] ?? session.agent}
            {session.contextTokens > 0 ? ` · ctx ${compact(session.contextTokens)}` : ''}
          </Text>
          <Text size="xs" muted>
            {ago(session.updatedAt)}
          </Text>
        </Row>
      </Stack>
    </Box>
  )
}

function OtherSession({ session }: { session: SessionProgress }) {
  return (
    <Row justify="between" align="center" gap="xs">
      <Row gap="xs" align="center">
        <Badge tone="neutral">{AGENT_NAME[session.agent] ?? session.agent}</Badge>
        <Text size="xs" muted truncate>
          {session.goal || '（无标题）'}
        </Text>
      </Row>
      <Text size="xs" muted>
        {session.state ? STATE_TEXT[session.state] : ago(session.updatedAt)}
      </Text>
    </Row>
  )
}

export default function Panel() {
  const snapshot = read(data)
  const busy = read(loading)
  const sessions = snapshot?.sessions ?? []
  const main = sessions[0]
  const others = sessions.slice(1)

  if (busy && !snapshot) {
    return <Spinner label="读取会话进度" />
  }

  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Stack gap="none">
          <Heading level={3}>会话进度</Heading>
          {snapshot?.workspace ? (
            <Text size="xs" muted truncate>
              {snapshot.workspace.name}
              {snapshot.workspace.branch ? ` · ${snapshot.workspace.branch}` : ''}
            </Text>
          ) : null}
        </Stack>
        <IconButton icon="refresh" label="刷新" tooltip="立即刷新" variant="ghost" onPress={() => void refresh()} />
      </Row>

      {snapshot?.error ? <Text size="sm" tone="warning">{snapshot.error}</Text> : null}

      {snapshot && !snapshot.error && sessions.length === 0 ? (
        <EmptyState title="没有可显示的会话" description="这个工作区最近没有 omp、Claude 或 Codex 的会话记录。" />
      ) : null}

      {main ? <MainSession session={main} /> : null}

      {others.length > 0 ? (
        <Collapsible title={`其他会话 · ${others.length}`} defaultOpen={false}>
          <Stack gap="xs">
            {others.map((session, index) => (
              <OtherSession key={`${session.agent}-${index}`} session={session} />
            ))}
          </Stack>
        </Collapsible>
      ) : null}
    </Stack>
  )
}