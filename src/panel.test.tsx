// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { ProgressSnapshot } from './protocol'

const empty: ProgressSnapshot = {
  workspace: { name: 'demo', branch: 'main', path: '/tmp/demo' },
  sessions: [],
  error: null
}

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
          name: '阶段一',
          tasks: [
            { content: '调研', status: 'completed' },
            { content: '复现', status: 'completed' }
          ]
        },
        {
          name: '阶段二',
          tasks: [
            { content: '改回调', status: 'in_progress' },
            { content: '补单测', status: 'pending' }
          ]
        }
      ],
      current: '改回调',
      currentPhase: '阶段二',
      next: ['补单测'],
      done: 2,
      total: 4,
      lastActivity: '调用 edit',
      recent: ['修改 oauth.ts'],
      startedAt: Date.now() - 6 * 60 * 1000,
      turnStartedAt: Date.now() - 90 * 1000,
      lastAt: Date.now() - 1_000,
      inputTokens: 240_000,
      outputTokens: 3_200,
      contextTokens: 92_700,
      turnOutputTokens: 456,
      updatedAt: Date.now() - 1_000
    }
  ]
}

test('shows the empty state when the workspace has no session', async () => {
  const host = mockHost({ requests: { 'progress.get': empty } })
  const view = await mount(panel, { host })
  await view.settled()
  assert.ok(view.find({ type: 'EmptyState' }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('shows progress, the current phase and what comes next', async () => {
  const host = mockHost({ requests: { 'progress.get': planned } })
  const view = await mount(panel, { host })
  await view.settled()
  assert.ok(view.find({ text: '修复登录重定向' }))
  assert.ok(view.find({ type: 'Progress' }))
  const tree = JSON.stringify(view.tree())
  assert.ok(tree.includes('改回调'))
  assert.ok(tree.includes('补单测'))
  // The status line counts the current turn like omp: context in, output out.
  assert.ok(view.find({ text: /↑\s*92\.7k\s*↓\s*456/ }))
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})