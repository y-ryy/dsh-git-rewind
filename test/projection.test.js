import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyGitRewindEvent, gitRewindView, initGitRewindState } from '../src/projection.js'

function event(seq, type, data, surfaceOp, time = seq * 1000) {
  return { seq, type, data, surfaceOp, time }
}

function user(seq, text) {
  return event(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, 'append')
}

test('projection folds appends and lists anchors newest first', () => {
  let state = initGitRewindState()
  const events = [
    event(0, 'turn/start', { turn: 1 }, undefined),
    user(1, 'first'),
    event(2, 'assistant/message', { message: { content: [] } }, 'append'),
    event(3, 'turn/end', { turn: 1 }, undefined),
    event(4, 'turn/start', { turn: 2 }, undefined),
    user(5, 'second'),
  ]
  for (const item of events) state = applyGitRewindEvent(state, item)
  const view = gitRewindView(state)
  assert.deepEqual(view.anchors.map((anchor) => anchor.preview), ['second', 'first'])
  assert.deepEqual(view.anchors.map((anchor) => anchor.turn), [2, 1])
})

test('only this plugin replace hides turns and updates the surface', () => {
  let state = initGitRewindState()
  state = applyGitRewindEvent(state, event(0, 'turn/start', { turn: 1 }, undefined))
  state = applyGitRewindEvent(state, user(1, 'first'))
  state = applyGitRewindEvent(state, event(2, 'turn/end', { turn: 1 }, undefined))
  state = applyGitRewindEvent(state, event(3, 'turn/start', { turn: 2 }, undefined))
  state = applyGitRewindEvent(state, user(4, 'second'))
  const placeholder = event(5, 'user/message', { content: [], source: { kind: 'dsh-git-rewind' } }, {
    op: 'replace', startSeq: 1, endSeq: 4,
  })
  state = applyGitRewindEvent(state, placeholder)
  const view = gitRewindView(state)
  assert.deepEqual(view.hiddenTurns, [1, 2])
  assert.equal(view.anchors.length, 0)
})

test('a foreign replacement does not hide turns', () => {
  let state = initGitRewindState()
  state = applyGitRewindEvent(state, event(0, 'turn/start', { turn: 1 }, undefined))
  state = applyGitRewindEvent(state, user(1, 'first'))
  state = applyGitRewindEvent(state, event(2, 'user/message', {
    content: [], source: { kind: 'compact-checkpoint' },
  }, { op: 'replace', startSeq: 1, endSeq: 1 }))
  const view = gitRewindView(state)
  assert.deepEqual(view.hiddenTurns, [])
  assert.equal(view.stoppedAtCompaction, true)
})
