import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCheckpointGraph, buildRepoGraph } from '../src/graph-model.js'

test('buildCheckpointGraph keeps sessions as lanes and sorts by time', () => {
  const indexes = [
    {
      sessionId: 'session-a', workspace: '/w', label: '修复登录',
      checkpoints: [
        { kind: 'turn', turn: 1, seq: 1, commit: 'a'.repeat(40), parent: null, time: 1000, preview: '第一条消息', stats: { files: 1, additions: 2, deletions: 0 } },
        { kind: 'turn', turn: 2, seq: 9, commit: 'b'.repeat(40), parent: 'a'.repeat(40), time: 3000, preview: '第二条消息', stats: { files: 2, additions: 3, deletions: 1 } },
      ],
    },
    {
      sessionId: 'session-b', workspace: '/w', label: '另一个会话',
      checkpoints: [
        { kind: 'turn', turn: 1, seq: 5, commit: 'c'.repeat(40), parent: null, time: 2000, preview: '另一个消息', stats: null },
      ],
    },
  ]
  const graph = buildCheckpointGraph(indexes, { currentSessionId: 'session-a', scope: 'workspace', limit: 10 })
  assert.equal(graph.source, 'checkpoints')
  assert.equal(graph.sessions.length, 2)
  assert.deepEqual(graph.commits.map((commit) => commit.shortHash), ['bbbbbbbb', 'cccccccc', 'aaaaaaaa'])
  assert.equal(graph.commits[0].current, true)
  assert.deepEqual(graph.commits[0].parents, ['a'.repeat(40)])
})

test('buildCheckpointGraph can limit to the current session', () => {
  const indexes = [
    { sessionId: 'a', workspace: '/w', checkpoints: [{ kind: 'turn', turn: 1, commit: 'a'.repeat(40), time: 1 }] },
    { sessionId: 'b', workspace: '/w', checkpoints: [{ kind: 'turn', turn: 1, commit: 'b'.repeat(40), time: 2 }] },
  ]
  const graph = buildCheckpointGraph(indexes, { currentSessionId: 'a', scope: 'session', limit: 10 })
  assert.deepEqual(graph.commits.map((commit) => commit.hash), ['a'.repeat(40)])
  assert.equal(graph.sessions.length, 1)
})

test('buildCheckpointGraph surfaces skipped checkpoints separately', () => {
  const graph = buildCheckpointGraph([
    {
      sessionId: 'a', workspace: '/w', checkpoints: [
        { kind: 'turn', turn: 1, skipped: true, reason: 'timeout', time: 3 },
        { kind: 'turn', turn: 2, commit: 'b'.repeat(40), time: 4, stats: null },
      ],
    },
  ], { currentSessionId: 'a', scope: 'session', limit: 10 })
  assert.equal(graph.commits.length, 1)
  assert.equal(graph.skipped.length, 1)
  assert.match(graph.skipped[0].subject, /timeout/)
})

test('buildRepoGraph carries branch status and decorations', () => {
  const graph = buildRepoGraph(
    { isRepo: true, branch: 'main', ahead: 2, behind: 1, dirty: 4 },
    [{ hash: 'a'.repeat(40), shortHash: 'aaaaaaa', parents: [], time: 1, subject: 'first', decorations: ['HEAD -> main'] }],
    10,
  )
  assert.equal(graph.source, 'repo')
  assert.equal(graph.branch, 'main')
  assert.equal(graph.dirty, 4)
  assert.equal(graph.commits[0].current, true)
})

test('buildCheckpointGraph marks deleted sessions and fork parents', () => {
  const graph = buildCheckpointGraph([
    {
      sessionId: 'parent', workspace: '/w', checkpoints: [
        { kind: 'turn', turn: 1, commit: 'p'.repeat(40), time: 1, stats: null },
      ],
    },
    {
      sessionId: 'child', workspace: '/w', parentSession: 'parent', checkpoints: [
        { kind: 'turn', turn: 1, commit: 'c'.repeat(40), time: 2, stats: null },
      ],
    },
    {
      sessionId: 'gone', workspace: '/w', checkpoints: [
        { kind: 'turn', turn: 1, commit: 'g'.repeat(40), time: 3, stats: null },
      ],
    },
  ], { currentSessionId: 'parent', scope: 'workspace', limit: 10, deletedIds: ['gone'] })
  const byId = new Map(graph.sessions.map((session) => [session.id, session]))
  assert.equal(byId.get('child').parentSession, 'parent')
  assert.equal(byId.get('gone').deleted, true)
  assert.equal(byId.get('parent').deleted, false)
  assert.equal(graph.commits.find((commit) => commit.sessionId === 'gone').deleted, true)
  assert.equal(graph.commits.find((commit) => commit.sessionId === 'parent').deleted, false)
})
