/**
 * `gitRewind` session projection: the client's read face.
 *
 * The unit mirrors the kernel's surface fold, enumerates the same anchors as
 * the Host (one first user prompt per turn), and records which turns this
 * plugin's own surface replacements hid.
 */
import { PROJECTION_KEY, SOURCE_KIND } from './constants.js'

// The projection registry only requires a schema-shaped object with a
// synchronous `parse` (and optionally `safeParse`). Keeping this local avoids
// making a workspace-installed plugin resolve a separate Zod instance from the
// DSH bundle; every value below is plain JSON by construction.
const passthroughSchema = {
  parse: (value) => value,
  safeParse: (value) => ({ success: true, data: value }),
}

const surfaceNodeSchema = {
  parse: (value) => value,
  safeParse: (value) => ({ success: true, data: value }),
}
const gitRewindStateSchema = passthroughSchema
const gitRewindViewSchema = passthroughSchema

export { surfaceNodeSchema }

const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

function readNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function readText(payload) {
  const record = payload
  if (!record || typeof record !== 'object') return ''
  const content = Array.isArray(record.content)
    ? record.content
    : Array.isArray(record.message?.content)
      ? record.message.content
      : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function isUserSource(payload) {
  const source = payload?.source
  return Boolean(source && typeof source === 'object' && source.kind === 'user')
}

function isCompactSource(payload) {
  const source = payload?.source
  return Boolean(source && typeof source === 'object' && source.kind === 'compact-checkpoint')
}

function readSurfaceOp(event) {
  const raw = event.surfaceOp
  if (raw === undefined) return undefined
  if (raw === 'append') return 'append'
  if (!raw || typeof raw !== 'object' || raw.op !== 'replace') return undefined
  const startSeq = readNonNegativeInteger(raw.startSeq)
  const endSeq = readNonNegativeInteger(raw.endSeq)
  if (startSeq === null || endSeq === null) return undefined
  return { startSeq, endSeq }
}

function isOwnReplacement(event) {
  return event?.data?.source?.kind === SOURCE_KIND
}

export function initGitRewindState() {
  return { nodes: [], hiddenTurns: [], openTurn: null }
}

export function applyGitRewindEvent(state, event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') return state
  if (event.type === 'turn/start') {
    const turn = readNonNegativeInteger(event.data?.turn)
    return turn === null || turn === state.openTurn ? state : { ...state, openTurn: turn }
  }
  if (!SURFACE_EVENT_TYPES.has(event.type)) return state
  const op = readSurfaceOp(event)
  if (op === undefined) return state
  const seq = readNonNegativeInteger(event.seq)
  if (seq === null) return state
  const time = readNonNegativeInteger(event.time) ?? 0
  const prompt = event.type === 'user/message' && isUserSource(event.data)
  const checkpoint = event.type === 'user/message' && isCompactSource(event.data)
  const node = {
    seq,
    time,
    turn: state.openTurn,
    prompt,
    checkpoint,
    text: prompt ? readText(event.data) : '',
  }
  if (op === 'append') {
    return { ...state, nodes: [...state.nodes, node] }
  }
  const startIndex = state.nodes.findIndex((item) => item.seq === op.startSeq)
  const endIndex = state.nodes.findIndex((item) => item.seq === op.endSeq)
  if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) return state
  const nextNodes = [...state.nodes.slice(0, startIndex), node, ...state.nodes.slice(endIndex + 1)]
  if (!isOwnReplacement(event)) {
    return { ...state, nodes: nextNodes }
  }
  const hiddenTurns = [...state.hiddenTurns]
  for (const item of state.nodes.slice(startIndex, endIndex + 1)) {
    if (item.turn !== null && !hiddenTurns.includes(item.turn)) hiddenTurns.push(item.turn)
  }
  hiddenTurns.sort((left, right) => left - right)
  return { ...state, nodes: nextNodes, hiddenTurns }
}

export function gitRewindView(state) {
  const anchors = []
  const openers = new Set()
  const claimed = new Set()
  for (const node of state.nodes) {
    if (!node.prompt) continue
    if (node.turn === null) {
      openers.add(node.seq)
      continue
    }
    if (claimed.has(node.turn)) continue
    claimed.add(node.turn)
    openers.add(node.seq)
  }
  for (let index = state.nodes.length - 1; index >= 0; index -= 1) {
    const node = state.nodes[index]
    if (!openers.has(node.seq)) continue
    anchors.push({
      n: anchors.length + 1,
      seq: node.seq,
      turn: node.turn,
      time: node.time,
      preview: previewText(node.text),
    })
  }
  return {
    anchors,
    hiddenTurns: state.hiddenTurns,
    stoppedAtCompaction: state.nodes.some((node) => node.checkpoint),
  }
}

function previewText(text) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}…`
}

export const gitRewindProjection = {
  key: PROJECTION_KEY,
  stateSchema: gitRewindStateSchema,
  init: () => initGitRewindState(),
  apply: applyGitRewindEvent,
  wire: {
    viewSchema: gitRewindViewSchema,
    view: gitRewindView,
  },
  stateVersion: 1,
}

export function registerGitRewindProjection(registry) {
  return registry.register(gitRewindProjection)
}
