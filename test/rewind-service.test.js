import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RewindService } from '../src/rewind-service.js'

function makeSession() {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 }, time: 1000 },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }, time: 1100 },
    { seq: 2, type: 'turn/end', data: { turn: 1 }, time: 1200 },
    { seq: 3, type: 'turn/start', data: { turn: 2 }, time: 2000 },
    { seq: 4, type: 'user/message', data: { content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }, time: 2100 },
    { seq: 5, type: 'turn/end', data: { turn: 2 }, time: 2200 },
  ]
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const appended = []
  return {
    id: 's1',
    header: { cwd: '/workspace' },
    surface: { nodes: [1, 4] },
    seq: 6,
    eventAt: (seq) => bySeq.get(seq),
    snapshotEvents: () => events,
    append(type, data, options) {
      appended.push({ type, data, options })
      return { type, data, options, seq: this.seq }
    },
    appended,
  }
}

function makeService(session, overrides = {}) {
  const restored = []
  const store = {
    preview: async () => ({
      checkpoint: { commit: 'a'.repeat(40), turn: 1, time: 1 },
      files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 0 }],
      summary: { changed: 1, added: 0, deleted: 0, additions: 1, deletions: 0 },
      coverage: 'full',
      warnings: [],
    }),
    restore: async (sessionId, cwd, turn) => {
      restored.push({ sessionId, cwd, turn })
      return { restored: 1, quarantined: [], rescueId: 'b'.repeat(40), warnings: [] }
    },
    listIndexes: async () => overrides.indexes ?? [
      { sessionId: session?.id ?? 's1', workspace: '/workspace', checkpoints: [{ kind: 'turn', turn: 2, commit: 'c'.repeat(40) }] },
    ],
    ...overrides.store,
  }
  const agents = overrides.agents ?? { list: () => [] }
  const ctx = {
    sessions: {
      get: (id) => (overrides.sessionsGet ? overrides.sessionsGet(id) : (id === session?.id ? session : undefined)),
      flush: async () => true,
    },
    get(name) {
      if (name === 'workingDirectory') return { get: (s) => s?.header?.cwd ?? '/workspace' }
      if (name === 'sessionController') {
        return { resolveAgent: async () => (overrides.resolveAgent ?? { agent: { id: session?.id ?? 's1' } }) }
      }
      if (name === 'agents') return agents
      return undefined
    },
  }
  return { service: new RewindService(ctx, { previewLimit: 500 }, store), store, restored }
}

test('apply with both recalls the surface and restores files', async () => {
  const session = makeSession()
  const { service, restored } = makeService(session)
  const result = await service.apply('s1', { seq: 4 }, 'both')
  assert.equal(result.recalled, true)
  assert.equal(session.appended.length, 1)
  assert.equal(session.appended[0].type, 'user/message')
  assert.deepEqual(session.appended[0].options.surfaceOp, { op: 'replace', startSeq: 4, endSeq: 4 })
  assert.deepEqual(session.appended[0].options.sourceEventSeqs, [4])
  assert.equal(result.restored, 1)
  assert.deepEqual(restored, [{ sessionId: 's1', cwd: '/workspace', turn: 2 }])
})

test('files-only can be addressed by turn directly', async () => {
  const session = makeSession()
  const { service, restored } = makeService(session)
  const result = await service.apply('s1', { turn: 1 }, 'files')
  assert.equal(result.recalled, false)
  assert.equal(result.turn, 1)
  assert.deepEqual(restored, [{ sessionId: 's1', cwd: '/workspace', turn: 1 }])
  assert.equal(session.appended.length, 0)
})

test('messages-only never touches the file store', async () => {
  let restored = 0
  const session = makeSession()
  const { service } = makeService(session, {
    store: {
      restore: async () => { restored += 1; return { restored: 1, quarantined: [], rescueId: null, warnings: [] } },
    },
  })
  await service.apply('s1', { seq: 1 }, 'messages')
  assert.equal(session.appended.length, 1)
  assert.equal(restored, 0)
})

test('a running turn is refused before the surface is touched', async () => {
  const session = makeSession()
  session.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } } },
  ]
  const { service } = makeService(session)
  await assert.rejects(() => service.apply('s1', { seq: 1 }, 'messages'), (error) => error.code === 'busy')
  assert.equal(session.appended.length, 0)
})

test('a deleted session still supports files-only restore from its index', async () => {
  const { service, restored } = makeService(null, {
    indexes: [{ sessionId: 'deleted', workspace: '/old-ws', checkpoints: [{ kind: 'turn', turn: 3, commit: 'd'.repeat(40) }] }],
    sessionsGet: () => undefined,
    resolveAgent: { error: { code: 'session/not-found' } },
  })
  const result = await service.apply('deleted', { turn: 3 }, 'files')
  assert.equal(result.recalled, false)
  assert.equal(result.turn, 3)
  assert.deepEqual(restored, [{ sessionId: 'deleted', cwd: '/old-ws', turn: 3 }])
})

test('messages modes refuse a deleted session', async () => {
  const { service } = makeService(null, {
    sessionsGet: () => undefined,
    resolveAgent: { error: { code: 'session/not-found' } },
  })
  await assert.rejects(() => service.apply('deleted', { seq: 1 }, 'messages'), (error) => error.code === 'not-found')
})

test('files restore is refused while another session in the same workspace is running', async () => {
  const session = makeSession()
  const running = makeSession()
  running.id = 'other'
  running.snapshotEvents = () => [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: 'busy' }], source: { kind: 'user' } } },
  ]
  const { service, restored } = makeService(session, {
    agents: { list: () => [{ id: 's1' }, { id: 'other' }] },
    sessionsGet: (id) => (id === 's1' ? session : id === 'other' ? running : undefined),
  })
  await assert.rejects(() => service.apply('s1', { turn: 2 }, 'files'), (error) => error.code === 'busy')
  assert.equal(restored.length, 0)
})

test('files restore ignores other workspaces when checking concurrent sessions', async () => {
  const session = makeSession()
  const runningElsewhere = makeSession()
  runningElsewhere.id = 'elsewhere'
  runningElsewhere.header = { cwd: '/another-workspace' }
  const { service, restored } = makeService(session, {
    agents: { list: () => [{ id: 's1' }, { id: 'elsewhere' }] },
    sessionsGet: (id) => (id === 's1' ? session : id === 'elsewhere' ? runningElsewhere : undefined),
  })
  const result = await service.apply('s1', { turn: 2 }, 'files')
  assert.equal(result.turn, 2)
  assert.equal(restored.length, 1)
})
