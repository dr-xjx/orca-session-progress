// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. Seed what the worker reads so check shows more than the first state.
import { defineCheck } from 'orca/testing'
import type { ProgressSnapshot } from './protocol'

/** A planned session, so check and `orca plugin shot --scenario` draw the task tree. */
const planned: ProgressSnapshot = {
  workspace: { name: 'demo', branch: 'main', path: '/tmp/demo' },
  error: null,
  sessions: [
    {
      agent: 'omp',
      state: 'working',
      goal: '修复登录重定向',
      phases: [
        {
          name: '阶段一：调研',
          tasks: [
            { content: '读 OAuth 回调链路', status: 'completed' },
            { content: '复现跳转丢失', status: 'completed' }
          ]
        },
        {
          name: '阶段二：实现',
          tasks: [
            { content: '改回调参数拼接', status: 'in_progress' },
            { content: '补重定向单测', status: 'pending' }
          ]
        }
      ],
      current: '改回调参数拼接',
      currentPhase: '阶段二：实现',
      next: ['补重定向单测'],
      done: 2,
      total: 4,
      lastActivity: '调用 edit',
      recent: ['修改 oauth.ts', '运行 vitest oauth'],
      startedAt: Date.now() - 6 * 60 * 1000,
      turnStartedAt: Date.now() - 90 * 1000,
      lastAt: Date.now() - 5 * 1000,
      inputTokens: 240_000,
      outputTokens: 3_200,
      contextTokens: 92_700,
      turnOutputTokens: 456,
      updatedAt: Date.now() - 5 * 1000
    }
  ]
}

export default defineCheck({
  fresh: {},
  planned: { requests: { 'progress.get': planned } }
})