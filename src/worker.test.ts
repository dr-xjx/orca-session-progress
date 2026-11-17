// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('answers that no workspace is focused when Orca reports none', async () => {
  const host = mockHost({ results: { 'workspace.readContext': null } })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('progress.get')
  assert.equal(answer.error, 'Orca 没有报告聚焦的工作区。')
  assert.deepEqual(answer.sessions, [])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('finds the focused workspace by name and branch', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': {
        workspaces: [
          { id: 'a', kind: 'worktree', name: 'other', project: null, path: '/nonexistent/other', branch: 'main', hostId: null },
          { id: 'b', kind: 'worktree', name: 'demo', project: null, path: '/nonexistent/demo', branch: 'main', hostId: null }
        ],
        truncated: false
      },
      'agents.list': { agents: [] }
    }
  })
  const worker = await mountWorker(main, { host })
  const answer = await worker.request('progress.get')
  assert.equal(answer.workspace?.path, '/nonexistent/demo')
  assert.deepEqual(answer.sessions, [])
  assert.equal(answer.error, null)
  await worker.deactivate()
})