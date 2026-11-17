// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

/** How one task of a session's plan reads. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned'

export type ProgressTask = { content: string; status: TaskStatus }

/** omp groups tasks in phases; Claude has no phases, so its tasks share one. */
export type ProgressPhase = { name: string; tasks: ProgressTask[] }

export type SessionProgress = {
  /** 'omp', 'claude', 'codex', or 'pi' */
  agent: string
  /** Agent state as Orca reports it for this workspace, when one can be matched. */
  state: 'working' | 'blocked' | 'waiting' | 'done' | null
  /** First user message, one line, truncated. */
  goal: string
  /** Plan phases, in the agent's order. Empty when the session has no todo list yet. */
  phases: ProgressPhase[]
  /** The task in progress, else the first pending task. */
  current: string | null
  /** The phase the current task belongs to. */
  currentPhase: string | null
  /** Pending tasks after the current one, at most three. */
  next: string[]
  done: number
  total: number
  /** Last assistant text or tool call, one line. */
  lastActivity: string | null
  /** The newest distinct tool actions, newest first, at most four. */
  recent: string[]
  /** First record of the session, epoch ms. */
  startedAt: number | null
  /** The newest user message, so the panel can time the current turn. */
  turnStartedAt: number | null
  /** Newest record of the session, epoch ms. */
  lastAt: number | null
  /** Sum of input, cache-read and cache-write tokens over the session. */
  inputTokens: number
  /** Sum of output tokens over the session. */
  outputTokens: number
  /** The newest message's whole context, for a context line. */
  contextTokens: number
  /** Output tokens since the newest user prompt, as omp's status line counts them. */
  turnOutputTokens: number
  /** Session file last write, epoch ms. */
  updatedAt: number
}

export type ProgressSnapshot = {
  workspace: { name: string; branch: string | null; path: string } | null
  sessions: SessionProgress[]
  /** Set when the focused workspace or its folder could not be resolved. */
  error: string | null
}

declare module 'orca' {
  interface PluginRequests {
    /** Reads the focused workspace's recent agent sessions and their latest plan. */
    'progress.get': { output: ProgressSnapshot }
  }
}