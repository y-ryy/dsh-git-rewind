import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compactionBoundary,
  findAnchorBySeq,
  listAnchors,
  messageText,
  planCut,
} from '../src/anchors.js'

function event(seq, type, data, time = seq * 1000) {
  return { seq, type, data, time }
}

function session(events) {
  const bySeq = new Map(events.map((item) => [item.seq, item]))
  const surface = events
    .filter((item) => ['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'].includes(item.type))
    .map((item) => item.seq)
  return {
    surface: { nodes: surface },
    eventAt: (seq) => bySeq.get(seq),
    seq: events.length,
  }
}

function user(seq, text, kind = 'user') {
  return event(seq, 'user/message', {
    content: text === null ? [] : [{ type: 'text', text }],
    source: { kind },
  })
}

test('messageText joins text blocks and ignores other content', () => {
  assert.equal(messageText(user(1, 'hello')), 'hello')
  assert.equal(messageText(user(2, null)), '')
})

test('listAnchors keeps the first prompt of each turn, newest first', () => {
  const s = session([
    event(0, 'turn/start', { turn: 1 }),
    user(1, 'first'),
    event(2, 'assistant/message', { message: { content: [] } }),
    user(3, 'steering', 'steering'),
    event(4, 'turn/end', { turn: 1 }),
    event(5, 'turn/start', { turn: 2 }),
    user(6, 'second'),
    event(7, 'turn/end', { turn: 2 }),
  ])
  const anchors = listAnchors(s)
  assert.deepEqual(anchors.map((anchor) => anchor.preview), ['second', 'first'])
  assert.deepEqual(anchors.map((anchor) => anchor.turn), [2, 1])
  assert.equal(anchors[0].n, 1)
  assert.equal(findAnchorBySeq(s, 6).preview, 'second')
})

test('attachment-only messages are still recall anchors', () => {
  const s = session([
    event(0, 'turn/start', { turn: 1 }),
    user(1, null),
    event(2, 'turn/end', { turn: 1 }),
  ])
  const anchors = listAnchors(s)
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].preview, '')
})

test('planCut covers the target and the whole tail of the surface', () => {
  const s = session([
    event(0, 'turn/start', { turn: 1 }),
    user(1, 'first'),
    event(2, 'assistant/message', { message: { content: [] } }),
    event(3, 'turn/end', { turn: 1 }),
    event(4, 'turn/start', { turn: 2 }),
    user(5, 'second'),
    event(6, 'assistant/message', { message: { content: [] } }),
    event(7, 'turn/end', { turn: 2 }),
  ])
  const cut = planCut(s, 2)
  assert.equal(cut.startSeq, 1)
  assert.equal(cut.endSeq, 6)
  assert.deepEqual(cut.shadowedSeqs, [1, 2, 5, 6])
  assert.deepEqual(cut.turns, [1, 2])
  assert.equal(cut.prompt, 'first')
})

test('compaction checkpoint bounds the recallable range', () => {
  const s = session([
    event(0, 'turn/start', { turn: 1 }),
    user(1, 'old'),
    event(2, 'turn/end', { turn: 1 }),
    event(3, 'turn/start', { turn: 2 }),
    user(4, 'checkpoint', 'compact-checkpoint'),
    event(5, 'turn/end', { turn: 2 }),
    event(6, 'turn/start', { turn: 3 }),
    user(7, 'new'),
    event(8, 'turn/end', { turn: 3 }),
  ])
  // A real compaction replaces the prefix with the checkpoint node; model the
  // surface that remains after that replacement.
  s.surface.nodes = [4, 7]
  assert.equal(compactionBoundary(s), 4)
  // The compaction checkpoint itself is not a prompt; only the surviving
  // prompt after it remains recallable.
  assert.deepEqual(listAnchors(s).map((anchor) => anchor.preview), ['new'])
  const failure = planCut(s, 2)
  assert.equal(failure.reason, 'compactionBoundary')
})

test('planCut reports an empty or out-of-range surface without inventing anchors', () => {
  assert.deepEqual(planCut(session([event(0, 'turn/start', { turn: 1 })]), 1), { reason: 'empty' })
  const s = session([
    event(0, 'turn/start', { turn: 1 }),
    user(1, 'only'),
    event(2, 'turn/end', { turn: 1 }),
  ])
  assert.equal(planCut(s, 2).reason, 'outOfRange')
})
