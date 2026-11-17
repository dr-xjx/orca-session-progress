// Reads the focused workspace's recent agent sessions and the plan each one keeps.
// omp stores phases and tasks in its `todo` tool results; Claude in TodoWrite calls;
// Codex in update_plan calls. Nothing is written and no agent is contacted.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  ProgressPhase,
  ProgressSnapshot,
  ProgressTask,
  SessionProgress,
  TaskStatus
} from './protocol'

const HOME = os.homedir()
const TAIL_BYTES = 2 * 1024 * 1024
const HEAD_BYTES = 64 * 1024
const MAX_SESSIONS = 3
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Token and time fields are filled from scanTokenStats after the file is parsed. */
const NO_STATS = {
  startedAt: null,
  turnStartedAt: null,
  lastAt: null,
  inputTokens: 0,
  outputTokens: 0,
  contextTokens: 0,
  turnOutputTokens: 0
} as const

type FileState = { mtime: number; size: number; session: SessionProgress | null }
/** A session file is re-parsed only after its mtime or size changes. */
const fileCache = new Map<string, FileState>()
/** Codex keeps every session in one date tree; cache the cwd read from each file's first line. */
const codexCwdCache = new Map<string, { mtime: number; cwd: string | null }>()
let codexScanAt = 0
let codexFiles: { file: string; mtime: number; cwd: string }[] = []

function oneLine(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function isUserPrompt(text: string): boolean {
  const value = text.trim()
  if (!value) return false
  if (value.startsWith('<')) return false
  if (value.startsWith('Caveat:')) return false
  return true
}

function normalizeStatus(value: unknown): TaskStatus {
  if (value === 'completed' || value === 'in_progress' || value === 'pending' || value === 'abandoned') {
    return value
  }
  if (value === 'done') return 'completed'
  if (value === 'inProgress' || value === 'in-progress' || value === 'running') return 'in_progress'
  if (value === 'cancelled' || value === 'canceled') return 'abandoned'
  return 'pending'
}

function normalizePhases(value: unknown): ProgressPhase[] {
  if (!Array.isArray(value)) return []
  const phases: ProgressPhase[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const phase = raw as { name?: unknown; tasks?: unknown }
    if (!Array.isArray(phase.tasks)) continue
    const tasks: ProgressTask[] = []
    for (const item of phase.tasks) {
      if (!item || typeof item !== 'object') continue
      const task = item as { content?: unknown; status?: unknown }
      if (typeof task.content !== 'string' || !task.content.trim()) continue
      tasks.push({ content: task.content.trim(), status: normalizeStatus(task.status) })
    }
    if (tasks.length > 0) {
      phases.push({ name: typeof phase.name === 'string' && phase.name.trim() ? phase.name.trim() : '任务', tasks })
    }
  }
  return phases
}

function flatTodos(value: unknown): ProgressPhase[] {
  if (!Array.isArray(value)) return []
  const tasks: ProgressTask[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const task = item as { content?: unknown; status?: unknown }
    if (typeof task.content !== 'string' || !task.content.trim()) continue
    tasks.push({ content: task.content.trim(), status: normalizeStatus(task.status) })
  }
  return tasks.length > 0 ? [{ name: '任务清单', tasks }] : []
}

/** One readable line for a tool call, from the fields agents usually put the target in. */
function toolSummary(name: string, input: unknown): string {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : null
  const file = value?.file_path ?? value?.path ?? value?.target_file ?? value?.filePath
  if (typeof file === 'string' && file.trim()) {
    return `${name} ${file.split(/[\\/]/).pop()}`
  }
  const command = value?.command ?? value?.cmd
  if (typeof command === 'string' && command.trim()) {
    return `${name}: ${oneLine(command, 70)}`
  }
  return name
}

function summarize(phases: ProgressPhase[]): Pick<SessionProgress, 'current' | 'currentPhase' | 'next' | 'done' | 'total'> {
  const tasks = phases.flatMap((phase) => phase.tasks.map((task) => ({ ...task, phase: phase.name })))
  const total = tasks.length
  const done = tasks.filter((task) => task.status === 'completed').length
  const active = tasks.find((task) => task.status === 'in_progress')
  const current = active ?? tasks.find((task) => task.status === 'pending') ?? null
  const start = current ? tasks.indexOf(current) : tasks.length
  const next = tasks
    .slice(start + 1)
    .filter((task) => task.status === 'pending')
    .slice(0, 3)
    .map((task) => task.content)
  return {
    current: current?.content ?? null,
    currentPhase: current?.phase ?? null,
    next,
    done,
    total
  }
}

async function readRange(file: string, start: number, length: number): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

async function readHead(file: string, size: number): Promise<string[]> {
  return (await readRange(file, 0, Math.min(size, HEAD_BYTES))).split('\n')
}

type TokenStats = {
  size: number
  remainder: string
  startedAt: number | null
  turnStartedAt: number | null
  lastAt: number | null
  input: number
  output: number
  context: number
  /** Output tokens since the newest user prompt, as omp's status line counts them. */
  turnOutput: number
}
/** Session files only grow, so token totals are scanned once and extended as lines arrive. */
const tokenCache = new Map<string, TokenStats>()

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function usageField(usage: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = numberField(usage[key])
    if (value !== 0) return value
  }
  return 0
}

function addUsage(agent: string, record: Record<string, unknown>, state: TokenStats): void {
  const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
  if (Number.isFinite(timestamp)) {
    state.startedAt ??= timestamp
    state.lastAt = timestamp
  }
  if (agent === 'omp' || agent === 'pi') {
    if (record.type !== 'message') return
    const message = record.message as { role?: unknown; content?: unknown; usage?: Record<string, unknown> } | undefined
    if (!message) return
    if (message.role === 'user' && isUserPrompt(textOf(message.content))) {
      if (Number.isFinite(timestamp)) state.turnStartedAt = timestamp
      state.turnOutput = 0
    }
    if (message.role !== 'assistant' || !message.usage) return
    const usage = message.usage
    const input = usageField(usage, 'input', 'inputTokens')
    const output = usageField(usage, 'output', 'outputTokens')
    const cacheRead = usageField(usage, 'cacheRead', 'cache_read', 'cache_read_tokens')
    const cacheWrite = usageField(usage, 'cacheWrite', 'cache_write', 'cache_creation_tokens')
    state.input += input + cacheRead + cacheWrite
    state.output += output
    state.turnOutput += output
    state.context = usageField(usage, 'totalTokens', 'total_tokens') || input + output + cacheRead + cacheWrite
    return
  }
  if (agent === 'claude') {
    const message = record.message as { role?: unknown; content?: unknown; usage?: Record<string, unknown> } | undefined
    if (record.type === 'user' && message) {
      if (isUserPrompt(textOf(message.content))) {
        if (Number.isFinite(timestamp)) state.turnStartedAt = timestamp
        state.turnOutput = 0
      }
      return
    }
    if (record.type !== 'assistant' || !message?.usage) return
    const usage = message.usage
    const input = usageField(usage, 'input_tokens', 'inputTokens')
    const output = usageField(usage, 'output_tokens', 'outputTokens')
    const cacheRead = usageField(usage, 'cache_read_input_tokens')
    const cacheWrite = usageField(usage, 'cache_creation_input_tokens')
    state.input += input + cacheRead + cacheWrite
    state.output += output
    state.turnOutput += output
    state.context = input + output + cacheRead + cacheWrite
    return
  }
  if (agent === 'codex') {
    const payload = record.payload as Record<string, unknown> | undefined
    if (!payload) return
    if (payload.type === 'token_count') {
      const info = payload.info as Record<string, unknown> | undefined
      const total = (info?.total_token_usage ?? info?.totalTokenUsage) as Record<string, unknown> | undefined
      if (total) {
        state.input = usageField(total, 'input_tokens', 'inputTokens')
        state.output = usageField(total, 'output_tokens', 'outputTokens')
        state.context = usageField(total, 'total_tokens', 'totalTokens')
      }
      const last = (info?.last_token_usage ?? info?.lastTokenUsage) as Record<string, unknown> | undefined
      if (last) state.turnOutput = usageField(last, 'output_tokens', 'outputTokens')
      return
    }
    if (payload.type === 'user_message' || (payload.type === 'message' && payload.role === 'user')) {
      if (Number.isFinite(timestamp)) state.turnStartedAt = timestamp
    }
  }
}

async function scanTokenStats(file: string, agent: string): Promise<TokenStats> {
  const stat = await fs.stat(file)
  let state = tokenCache.get(file)
  if (!state || stat.size < state.size) {
    state = {
      size: 0,
      remainder: '',
      startedAt: null,
      turnStartedAt: null,
      lastAt: null,
      input: 0,
      output: 0,
      context: 0,
      turnOutput: 0
    }
  }
  if (stat.size === state.size) return state
  const chunk = await readRange(file, state.size, stat.size - state.size)
  const lines = (state.remainder + chunk).split('\n')
  state.remainder = lines.pop() ?? ''
  for (const line of lines) {
    const record = parseJson(line)
    if (record) addUsage(agent, record, state)
  }
  state.size = stat.size
  tokenCache.set(file, state)
  return state
}

function withStats(session: SessionProgress, stats: TokenStats): SessionProgress {
  return {
    ...session,
    startedAt: stats.startedAt,
    turnStartedAt: stats.turnStartedAt,
    lastAt: stats.lastAt,
    inputTokens: stats.input,
    outputTokens: stats.output,
    contextTokens: stats.context,
    turnOutputTokens: stats.turnOutput
  }
}

async function readTail(file: string, size: number): Promise<string[]> {
  const start = Math.max(0, size - TAIL_BYTES)
  const lines = (await readRange(file, start, size - start)).split('\n')
  // The first line of a tail read is usually cut in half.
  if (start > 0) lines.shift()
  return lines
}

function parseJson(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) return null
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function goalFromHead(lines: string[], agent: string): string {
  for (const line of lines) {
    const record = parseJson(line)
    if (!record) continue
    if (agent === 'omp' || agent === 'pi') {
      if (record.type !== 'message' && record.type !== 'message_start' && record.type !== 'message_end') continue
      const message = record.message as { role?: unknown; content?: unknown } | undefined
      if (message?.role !== 'user') continue
      const text = textOf(message.content)
      if (isUserPrompt(text)) return oneLine(text)
    } else if (agent === 'claude') {
      if (record.type !== 'user') continue
      const message = record.message as { content?: unknown } | undefined
      const text = textOf(message?.content) || (typeof record.content === 'string' ? record.content : '')
      if (isUserPrompt(text)) return oneLine(text)
    } else if (agent === 'codex') {
      const payload = record.payload as Record<string, unknown> | undefined
      if (!payload) continue
      if (payload.type === 'user_message' && typeof payload.message === 'string' && isUserPrompt(payload.message)) {
        return oneLine(payload.message)
      }
      if (payload.type === 'message' && payload.role === 'user') {
        const text = textOf(payload.content)
        if (isUserPrompt(text)) return oneLine(text)
      }
    }
  }
  return ''
}

function parseOmp(file: string, tail: string[], head: string[]): SessionProgress | null {
  let phases: ProgressPhase[] = []
  let activity: string | null = null
  let title: string | null = null
  const recent: string[] = []
  const remember = (action: string | null): void => {
    if (action && recent.length < 4 && !recent.includes(action)) recent.push(action)
  }
  for (let index = tail.length - 1; index >= 0; index--) {
    const record = parseJson(tail[index])
    if (!record) continue
    if (title === null) {
      if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) {
        title = oneLine(record.aiTitle)
      } else if (record.type === 'title' && typeof record.title === 'string' && record.title.trim()) {
        title = oneLine(record.title)
      }
    }
    if (phases.length === 0) {
      let candidate: unknown
      if (record.type === 'tool_execution_end' && record.toolName === 'todo') {
        candidate = (record.result as { details?: { phases?: unknown } } | undefined)?.details?.phases
      } else if (
        record.type === 'message' ||
        record.type === 'message_start' ||
        record.type === 'message_end'
      ) {
        const message = record.message as
          | { role?: unknown; toolName?: unknown; details?: { phases?: unknown } }
          | undefined
        if (message?.role === 'toolResult' && message.toolName === 'todo') {
          candidate = message.details?.phases
        }
      } else if (record.type === 'custom' && record.customType === 'user_todo_edit') {
        candidate = (record.data as { phases?: unknown } | undefined)?.phases
      }
      phases = normalizePhases(candidate)
    }
    if (record.type === 'custom' && record.customType === 'tool_execution_start') {
      const data = record.data as { toolName?: unknown; intent?: unknown } | undefined
      const action =
        typeof data?.intent === 'string' && data.intent.trim()
          ? oneLine(data.intent, 90)
          : typeof data?.toolName === 'string'
            ? `调用 ${data.toolName}`
            : null
      remember(action)
      if (activity === null) activity = action
    }
    if (activity === null) {
      if (record.type === 'message' || record.type === 'message_end') {
        const message = record.message as { role?: unknown; content?: unknown } | undefined
        if (message?.role === 'assistant') {
          const text = textOf(message.content)
          if (text.trim()) activity = oneLine(text)
        }
        if (activity === null && message?.role === 'toolResult' && typeof message.toolName === 'string') {
          activity = `调用 ${message.toolName}`
        }
      }
      if (activity === null && record.type === 'tool_execution_end' && typeof record.toolName === 'string') {
        activity = `调用 ${record.toolName}`
      }
    }
    if (phases.length > 0 && activity !== null && title !== null) break
  }
  const goal = title ?? goalFromHead(head, 'omp')
  if (!goal && phases.length === 0) return null
  return {
    agent: 'omp',
    state: null,
    goal,
    phases,
    ...summarize(phases),
    lastActivity: activity ?? recent[0] ?? null,
    recent,
    ...NO_STATS,
    updatedAt: 0
  }
}

function parseClaude(file: string, tail: string[], head: string[]): SessionProgress | null {
  let phases: ProgressPhase[] = []
  let activity: string | null = null
  let title: string | null = null
  const recent: string[] = []
  const remember = (action: string | null): void => {
    if (action && recent.length < 4 && !recent.includes(action)) recent.push(action)
  }
  for (let index = tail.length - 1; index >= 0; index--) {
    const record = parseJson(tail[index])
    if (!record) continue
    if (title === null && record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) {
      title = oneLine(record.aiTitle)
    }
    const message = record.message as { role?: unknown; content?: unknown } | undefined
    const content = message?.content
    if (phases.length === 0 && Array.isArray(content)) {
      for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
        const block = content[blockIndex] as { type?: unknown; name?: unknown; input?: { todos?: unknown } }
        if (block?.type === 'tool_use' && block.name === 'TodoWrite') {
          phases = flatTodos(block.input?.todos)
          break
        }
      }
    }
    if (record.type === 'assistant' && Array.isArray(content)) {
      for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
        const block = content[blockIndex] as { type?: unknown; name?: unknown; input?: unknown }
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          remember(toolSummary(block.name, block.input))
        }
      }
      if (activity === null) {
        const text = textOf(content)
        if (text.trim()) activity = oneLine(text)
        if (activity === null) {
          const tool = content.find((block) => (block as { type?: unknown }).type === 'tool_use') as
            | { name?: unknown }
            | undefined
          if (typeof tool?.name === 'string') activity = `调用 ${tool.name}`
        }
      }
    }
    if (phases.length > 0 && activity !== null && title !== null && recent.length >= 3) break
  }
  const goal = title ?? goalFromHead(head, 'claude')
  if (!goal && phases.length === 0) return null
  return {
    agent: 'claude',
    state: null,
    goal,
    phases,
    ...summarize(phases),
    lastActivity: activity ?? recent[0] ?? null,
    recent,
    ...NO_STATS,
    updatedAt: 0
  }
}

function parseCodex(file: string, tail: string[], head: string[]): SessionProgress | null {
  let phases: ProgressPhase[] = []
  let activity: string | null = null
  const recent: string[] = []
  const remember = (action: string | null): void => {
    if (action && recent.length < 4 && !recent.includes(action)) recent.push(action)
  }
  for (let index = tail.length - 1; index >= 0; index--) {
    const record = parseJson(tail[index])
    if (!record) continue
    const payload = record.payload as Record<string, unknown> | undefined
    if (!payload) continue
    if (phases.length === 0 && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
      if (payload.name === 'update_plan') {
        const raw = payload.arguments ?? payload.input
        try {
          const input = typeof raw === 'string' ? JSON.parse(raw) : raw
          phases = normalizePhases((input as { plan?: unknown } | null)?.plan)
        } catch {
          // A clipped argument is not a plan.
        }
      }
    }
    if (payload.type === 'function_call' && typeof payload.name === 'string') {
      let input: unknown
      try {
        input = typeof payload.arguments === 'string' ? JSON.parse(payload.arguments) : payload.arguments
      } catch {
        input = undefined
      }
      remember(toolSummary(payload.name, input))
    }
    if (activity === null) {
      if (payload.type === 'message' && payload.role === 'assistant') {
        const text = textOf(payload.content)
        if (text.trim()) activity = oneLine(text)
      }
      if (activity === null && payload.type === 'function_call' && typeof payload.name === 'string') {
        activity = `调用 ${payload.name}`
      }
    }
    if (phases.length > 0 && activity !== null && recent.length >= 3) break
  }
  const goal = goalFromHead(head, 'codex')
  if (!goal && phases.length === 0) return null
  return {
    agent: 'codex',
    state: null,
    goal,
    phases,
    ...summarize(phases),
    lastActivity: activity ?? recent[0] ?? null,
    recent,
    ...NO_STATS,
    updatedAt: 0
  }
}

async function readSession(file: string, agent: string): Promise<SessionProgress | null> {
  let stat
  try {
    stat = await fs.stat(file)
  } catch {
    return null
  }
  const stats = await scanTokenStats(file, agent).catch(() => null)
  const cached = fileCache.get(file)
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
    if (!cached.session) return null
    const copy = { ...cached.session, updatedAt: stat.mtimeMs }
    return stats ? withStats(copy, stats) : copy
  }
  let session: SessionProgress | null = null
  try {
    const tail = await readTail(file, stat.size)
    const head = await readHead(file, stat.size)
    if (agent === 'omp' || agent === 'pi') session = parseOmp(file, tail, head)
    else if (agent === 'claude') session = parseClaude(file, tail, head)
    else if (agent === 'codex') session = parseCodex(file, tail, head)
    if (session) {
      session.updatedAt = stat.mtimeMs
      const id = path.basename(file, '.jsonl')
      const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(id)
      ;(session as SessionProgress & { sessionId?: string }).sessionId = match?.[1] ?? id
    }
  } catch {
    session = null
  }
  fileCache.set(file, { mtime: stat.mtimeMs, size: stat.size, session })
  return session ? (stats ? withStats(session, stats) : session) : null
}

async function recentJsonl(dir: string): Promise<{ file: string; mtime: number }[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: { file: string; mtime: number }[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const file = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(file)
      if (Date.now() - stat.mtimeMs <= MAX_AGE_MS) files.push({ file, mtime: stat.mtimeMs })
    } catch {
      // A session removed while listing is simply absent.
    }
  }
  return files.sort((left, right) => right.mtime - left.mtime).slice(0, 6)
}

/** omp and pi name a session folder after the working directory below HOME. */
function homeRelativeSessionDir(root: string, cwd: string): string | null {
  const relative = path.relative(HOME, cwd)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null
  const token = relative === '' ? '-' : `-${relative.split(path.sep).join('-')}`
  return path.join(HOME, root, token)
}

/** Claude names a project folder after the absolute working directory. */
function claudeProjectDir(cwd: string): string {
  return path.join(HOME, '.claude', 'projects', cwd.split(path.sep).join('-'))
}

/** pi wraps the absolute path, without its leading slash, in double dashes. */
function piSessionDir(cwd: string): string {
  const flat = cwd.replace(/^[/\\]/, '').split(path.sep).join('-')
  return path.join(HOME, '.pi', 'agent', 'sessions', `--${flat}--`)
}

async function codexSessionsFor(cwd: string): Promise<{ file: string; mtime: number }[]> {
  const now = Date.now()
  if (now - codexScanAt > 60_000) {
    codexScanAt = now
    codexFiles = []
    const root = path.join(HOME, '.codex', 'sessions')
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 5) return
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(file, depth + 1)
          continue
        }
        if (!entry.name.endsWith('.jsonl')) continue
        try {
          const stat = await fs.stat(file)
          if (now - stat.mtimeMs > MAX_AGE_MS) continue
          const cached = codexCwdCache.get(file)
          if (cached && cached.mtime === stat.mtimeMs) {
            if (cached.cwd) codexFiles.push({ file, mtime: stat.mtimeMs, cwd: cached.cwd })
            continue
          }
          const first = (await readRange(file, 0, 64 * 1024)).split('\n')[0]
          const record = parseJson(first)
          const payload = record?.payload as { cwd?: unknown } | undefined
          const sessionCwd = record?.type === 'session_meta' && typeof payload?.cwd === 'string' ? payload.cwd : null
          codexCwdCache.set(file, { mtime: stat.mtimeMs, cwd: sessionCwd })
          if (sessionCwd) codexFiles.push({ file, mtime: stat.mtimeMs, cwd: sessionCwd })
        } catch {
          // Skip unreadable sessions.
        }
      }
    }
    await walk(root, 0)
  }
  return codexFiles
    .filter((entry) => entry.cwd === cwd)
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, 4)
    .map(({ file, mtime }) => ({ file, mtime }))
}

function matchState(
  agents: { agent: string | null; state: 'working' | 'blocked' | 'waiting' | 'done'; stateStartedAt: number }[],
  kind: string,
  updatedAt: number
): SessionProgress['state'] {
  const candidates = agents.filter((entry) => {
    if (!entry.agent) return false
    const name = entry.agent.toLowerCase()
    if (kind === 'omp') return name === 'omp' || name === 'pi'
    return name === kind
  })
  if (candidates.length === 0) return null
  const active = candidates.find((entry) => entry.state === 'working' || entry.state === 'blocked')
  if (active) return active.state
  const arrived = candidates
    .filter((entry) => entry.stateStartedAt <= updatedAt + 5_000)
    .sort((left, right) => right.stateStartedAt - left.stateStartedAt)[0]
  return (arrived ?? candidates[0]).state
}

async function focusedWorkspace(orca: OrcaWorkerApi): Promise<ProgressSnapshot['workspace']> {
  const context = await orca.host.call('workspace.readContext')
  if (!context) return null
  const listed = await orca.host.call('workspace.list')
  const workspaces = listed.workspaces
  const exact = workspaces.filter(
    (workspace) => workspace.name === context.displayName && (workspace.branch ?? null) === (context.branch ?? null)
  )
  const byBranch = workspaces.filter((workspace) => (workspace.branch ?? null) === (context.branch ?? null))
  const byName = workspaces.filter((workspace) => workspace.name === context.displayName)
  const chosen =
    exact.find((workspace) => workspace.hostId === null) ??
    exact[0] ??
    byBranch.find((workspace) => workspace.hostId === null) ??
    byBranch[0] ??
    byName.find((workspace) => workspace.hostId === null) ??
    byName[0] ??
    null
  return chosen
    ? { name: chosen.name, branch: chosen.branch, path: chosen.path }
    : null
}

async function collectSessions(cwd: string): Promise<SessionProgress[]> {
  const found: { file: string; agent: string }[] = []
  const ompDir = homeRelativeSessionDir(path.join('.omp', 'agent', 'sessions'), cwd)
  if (ompDir) {
    for (const entry of await recentJsonl(ompDir)) found.push({ file: entry.file, agent: 'omp' })
  }
  for (const entry of await recentJsonl(piSessionDir(cwd))) found.push({ file: entry.file, agent: 'pi' })
  for (const entry of await recentJsonl(claudeProjectDir(cwd))) found.push({ file: entry.file, agent: 'claude' })
  for (const entry of await codexSessionsFor(cwd)) found.push({ file: entry.file, agent: 'codex' })

  const sessions: SessionProgress[] = []
  for (const entry of found) {
    const session = await readSession(entry.file, entry.agent)
    if (session) sessions.push(session)
  }
  return sessions.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, MAX_SESSIONS)
}

async function snapshot(orca: OrcaWorkerApi): Promise<ProgressSnapshot> {
  const workspace = await focusedWorkspace(orca)
  if (!workspace) {
    return { workspace: null, sessions: [], error: 'Orca 没有报告聚焦的工作区。' }
  }
  let sessions: SessionProgress[]
  try {
    sessions = await collectSessions(workspace.path)
  } catch (error) {
    return {
      workspace,
      sessions: [],
      error: error instanceof Error ? error.message : '读取会话失败。'
    }
  }
  const agents = await orca.host
    .call('agents.list')
    .then((answer) => answer.agents)
    .catch(() => [])
  // Orca reports the agents running in the workspace now, not which session each one is.
  // The newest session of an agent kind is the only one the live state can belong to.
  const newestSeen = new Set<string>()
  for (const session of sessions) {
    if (newestSeen.has(session.agent)) continue
    newestSeen.add(session.agent)
    if (Date.now() - session.updatedAt <= 6 * 60 * 60 * 1000) {
      session.state = matchState(agents, session.agent, session.updatedAt)
    }
  }
  return { workspace, sessions, error: null }
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('progress.get', async () => {
    try {
      return await snapshot(orca)
    } catch (error) {
      orca.log(`progress.get failed: ${error instanceof Error ? error.message : String(error)}`)
      return { workspace: null, sessions: [], error: '读取进度失败，详见 orca plugin logs。' }
    }
  })
}