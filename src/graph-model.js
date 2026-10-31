/** Turn checkpoint indexes and repository logs into the sidebar graph model. */
import { previewText } from './anchors.js'

const LANE_COLORS = 8

function checkpointNodes(index, currentSessionId, colorIndex) {
  const nodes = []
  for (const record of index.checkpoints ?? []) {
    if (record.kind !== 'turn') continue
    if (record.skipped) {
      nodes.push({
        hash: `skipped-${index.sessionId}-${record.turn}`,
        shortHash: 'skip',
        parents: [],
        sessionId: index.sessionId,
        turn: record.turn,
        seq: record.seq ?? null,
        time: record.time ?? 0,
        subject: record.reason ? `未创建检查点：${record.reason}` : '未创建检查点',
        stats: null,
        kind: 'checkpoint',
        skipped: true,
        current: false,
        color: colorIndex,
      })
      continue
    }
    if (!record.commit) continue
    nodes.push({
      hash: record.commit,
      shortHash: String(record.commit).slice(0, 8),
      parents: record.parent ? [record.parent] : [],
      sessionId: index.sessionId,
      turn: record.turn,
      seq: record.seq ?? null,
      time: record.time ?? 0,
      subject: record.preview || index.label || `会话 ${String(index.sessionId).slice(-6)}`,
      stats: record.stats ?? null,
      kind: 'checkpoint',
      skipped: false,
      current: index.sessionId === currentSessionId,
      color: colorIndex,
    })
  }
  return nodes
}

/**
 * @param {Array<object>} indexes
 * @param {{currentSessionId:string, scope:'session'|'workspace', limit?:number, deletedIds?:Iterable<string>}} options
 */
export function buildCheckpointGraph(indexes, options) {
  const scope = options.scope === 'workspace' ? 'workspace' : 'session'
  const limit = Math.max(1, Math.min(500, options.limit ?? 200))
  const deletedIds = new Set(options.deletedIds ?? [])
  const selected = (indexes ?? [])
    .filter((index) => Array.isArray(index.checkpoints) && index.checkpoints.length > 0)
    .filter((index) => scope === 'workspace' || index.sessionId === options.currentSessionId)
    .sort((left, right) => String(left.sessionId).localeCompare(String(right.sessionId)))

  const sessions = selected.map((index, position) => ({
    id: index.sessionId,
    label: index.label || `会话 ${String(index.sessionId).slice(-6)}`,
    color: position % LANE_COLORS,
    current: index.sessionId === options.currentSessionId,
    parentSession: index.parentSession ?? null,
    deleted: deletedIds.has(index.sessionId),
  }))
  const colorById = new Map(sessions.map((session) => [session.id, session.color]))
  const deletedBySession = new Map(sessions.map((session) => [session.id, session.deleted]))
  const commits = []
  const skipped = []
  for (const index of selected) {
    const color = colorById.get(index.sessionId) ?? 0
    const deleted = deletedBySession.get(index.sessionId) ?? false
    for (const node of checkpointNodes(index, options.currentSessionId, color)) {
      node.deleted = deleted
      if (node.skipped) skipped.push(node)
      else commits.push(node)
    }
  }
  commits.sort((left, right) => right.time - left.time || String(left.hash).localeCompare(String(right.hash)))
  const limited = commits.slice(0, limit)
  const currentHashes = new Map()
  for (const commit of commits) {
    if (commit.current && !currentHashes.has(commit.sessionId)) currentHashes.set(commit.sessionId, commit.hash)
  }
  return {
    source: 'checkpoints',
    sessions,
    commits: limited.map((commit) => ({
      ...commit,
      current: currentHashes.get(commit.sessionId) === commit.hash,
    })),
    skipped: skipped.slice(0, limit),
    truncated: commits.length > limited.length,
  }
}

/** Add repo decorations and source tag to log commits. */
export function buildRepoGraph(status, commits, limit = 200) {
  const capped = Math.max(1, Math.min(500, limit))
  return {
    source: 'repo',
    isRepo: status?.isRepo === true,
    branch: status?.branch ?? null,
    ahead: status?.ahead ?? 0,
    behind: status?.behind ?? 0,
    dirty: status?.dirty ?? 0,
    commits: (commits ?? []).slice(0, capped).map((commit) => ({
      ...commit,
      kind: 'repo',
      current: (status?.branch ?? null) !== null && (commit.decorations ?? []).some((item) => item === `HEAD -> ${status.branch}` || item === status.branch),
    })),
    truncated: (commits ?? []).length > capped,
  }
}

/** Compact display summary used in the sidebar status strip. */
export function summarizeCheckpoint(graph) {
  return {
    sessions: graph.sessions.length,
    commits: graph.commits.length,
    skipped: graph.skipped.length,
    preview: previewText(graph.commits[0]?.subject ?? '', 80),
  }
}
