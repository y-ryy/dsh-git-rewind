/**
 * Recall anchors and surface-cut computation.
 *
 * The model-visible surface is an ordered list of event seqs. A recall point is
 * the first real user prompt of a turn. A cut replaces the chosen prompt and
 * everything after it on the surface with one empty user-message placeholder.
 */
import { randomUUID } from 'node:crypto'
import { MAX_ANCHORS, MAX_PREVIEW_CHARS, SOURCE_KIND } from './constants.js'

/** Read plain text from one message event payload. */
export function messageText(event) {
  if (!event || typeof event !== 'object') return ''
  const data = event.data
  if (!data || typeof data !== 'object') return ''
  const content = Array.isArray(data.content)
    ? data.content
    : Array.isArray(data.message?.content)
      ? data.message.content
      : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** Collapse whitespace and bound a preview string. */
export function previewText(text, max = MAX_PREVIEW_CHARS) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 1))}…`
}

/** Whether an event is a real user prompt rather than injected context/steering. */
export function isUserPrompt(event) {
  if (!event || event.type !== 'user/message') return false
  const source = event.data?.source
  return source && typeof source === 'object' && source.kind === 'user'
}

/** Whether an event was written by a compaction checkpoint. */
export function isCompactCheckpoint(event) {
  if (!event || event.type !== 'user/message') return false
  const source = event.data?.source
  return source && typeof source === 'object' && source.kind === 'compact-checkpoint'
}

/** Seq of the newest compaction checkpoint on the current surface, or null. */
export function compactionBoundary(session) {
  const nodes = session?.surface?.nodes ?? []
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const seq = nodes[index]
    const event = session.eventAt(seq)
    if (event && event.type === 'user/message' && isCompactCheckpoint(event)) return seq
  }
  return null
}

/** Map each surface node seq to the turn open at that point in the log. */
export function surfaceTurns(session) {
  const turns = new Map()
  const nodes = session?.surface?.nodes ?? []
  if (nodes.length === 0) return turns
  const nodeSet = new Set(nodes)
  let open = null
  const last = nodes[nodes.length - 1]
  for (let seq = 0; seq <= last; seq += 1) {
    const event = session.eventAt(seq)
    if (!event) continue
    if (event.type === 'turn/start') {
      const turn = event.data?.turn
      if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0) open = turn
      continue
    }
    if (open !== null && nodeSet.has(seq)) turns.set(seq, open)
  }
  return turns
}

/**
 * Recallable anchors newest first.
 * @returns {{n:number,seq:number,turn:number|null,time:number,preview:string}[]}
 */
export function listAnchors(session, max = MAX_ANCHORS) {
  const nodes = session?.surface?.nodes ?? []
  const turns = surfaceTurns(session)
  const openers = new Set()
  const claimed = new Set()
  for (const seq of nodes) {
    const event = session.eventAt(seq)
    if (!event || !isUserPrompt(event)) continue
    const turn = turns.get(seq) ?? null
    if (turn === null) {
      openers.add(seq)
      continue
    }
    if (claimed.has(turn)) continue
    claimed.add(turn)
    openers.add(seq)
  }

  const anchors = []
  for (let index = nodes.length - 1; index >= 0 && anchors.length < max; index -= 1) {
    const seq = nodes[index]
    if (!openers.has(seq)) continue
    const event = session.eventAt(seq)
    if (!event) continue
    anchors.push({
      n: anchors.length + 1,
      seq,
      turn: turns.get(seq) ?? null,
      time: event.time ?? 0,
      preview: previewText(messageText(event)),
      text: messageText(event),
    })
  }
  return anchors
}

/** Find one anchor by its surface seq. */
export function findAnchorBySeq(session, seq) {
  return listAnchors(session, MAX_ANCHORS).find((anchor) => anchor.seq === seq) ?? null
}

/** Find the anchor seq that opens a turn, or null. */
export function findAnchorSeqForTurn(session, turn) {
  const anchors = listAnchors(session, MAX_ANCHORS)
  return anchors.find((anchor) => anchor.turn === turn)?.seq ?? null
}

/**
 * Turn "ordinal n" into the exact replace range.
 * @returns {{startSeq:number,endSeq:number,shadowedSeqs:number[],turns:number[],prompt:string,turn:number|null,n:number}|{reason:string,available?:number}}
 */
export function planCut(session, n, max = MAX_ANCHORS) {
  const anchors = listAnchors(session, max)
  if (anchors.length === 0) {
    return compactionBoundary(session) === null
      ? { reason: 'empty' }
      : { reason: 'compactionBoundary', available: 0 }
  }
  if (!Number.isSafeInteger(n) || n < 1 || n > anchors.length) {
    const beyond = Number.isSafeInteger(n) && n > anchors.length && anchors.length < max
    const boundary = beyond ? compactionBoundary(session) : null
    return boundary === null
      ? { reason: 'outOfRange', available: anchors.length }
      : { reason: 'compactionBoundary', available: anchors.length }
  }
  const anchor = anchors[n - 1]
  const nodes = session?.surface?.nodes ?? []
  const startIndex = nodes.indexOf(anchor.seq)
  if (startIndex === -1) return { reason: 'notUserMessage' }
  const shadowedSeqs = nodes.slice(startIndex)
  if (shadowedSeqs.length === 0) return { reason: 'notUserMessage' }
  const turnMap = surfaceTurns(session)
  const turns = []
  for (const seq of shadowedSeqs) {
    const turn = turnMap.get(seq)
    if (turn !== undefined && !turns.includes(turn)) turns.push(turn)
  }
  turns.sort((left, right) => left - right)
  return {
    startSeq: anchor.seq,
    endSeq: shadowedSeqs[shadowedSeqs.length - 1],
    shadowedSeqs,
    turns,
    prompt: anchor.text ?? anchor.preview,
    turn: anchor.turn,
    n: anchor.n,
  }
}

/** The empty user message that carries a surface replacement. */
export function placeholderData() {
  return {
    id: randomUUID(),
    role: 'user',
    content: [],
    source: { kind: SOURCE_KIND },
  }
}
