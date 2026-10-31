/**
 * Same-origin `/api/plugins/dsh-git-rewind` routes.
 *
 * The Connection carrier applies its Host/Origin fence and browser
 * authentication before a handler runs. Bodies carry IDs, sequence numbers and
 * enum values only; paths are always derived from the stored workspace.
 */
import { resolve } from 'node:path'
import { listAnchors } from './anchors.js'
import { ROUTE_PREFIX } from './constants.js'
import { buildCheckpointGraph, buildRepoGraph } from './graph-model.js'
import { repoCommit, repoDiff, repoLog, repoStatus } from './git-repo.js'
import { RewindError } from './rewind-service.js'

const MAX_BODY_BYTES = 1024 * 1024
const SESSION_ID = /^[A-Za-z0-9._-]{1,160}$/
const HASH = /^[0-9a-f]{4,64}$/i

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ok(value) {
  return json(200, { ok: true, value })
}

function fail(status, code, message, details = undefined) {
  return json(status, { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } })
}

function errorResponse(error) {
  if (error instanceof RewindError) {
    const status = error.code === 'bad-request' ? 400
      : error.code === 'not-found' || error.code === 'no-checkpoint' ? 404
        : error.code === 'busy' || error.code === 'writer-held' ? 409
          : error.code === 'compaction-boundary' || error.code === 'path-rejected' ? 422
            : 500
    return fail(status, error.code, error.message, error.details)
  }
  if (error?.code && typeof error.code === 'string' && error.code.includes('-')) {
    return fail(500, error.code, error.message ?? String(error))
  }
  return fail(500, 'internal', error instanceof Error ? error.message : String(error))
}

async function readJsonBody(request) {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return undefined
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function readSessionId(body) {
  const sessionId = body?.sessionId
  return typeof sessionId === 'string' && SESSION_ID.test(sessionId) ? sessionId : null
}

function readSeq(body) {
  const seq = body?.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : null
}

function readMode(body) {
  return body?.mode === 'messages' || body?.mode === 'files' || body?.mode === 'both' ? body.mode : null
}

function readTurn(body) {
  const turn = body?.turn
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : null
}

export function registerRoutes(connectionFetch, service, store, config, hostCtx) {
  const preview = async (request) => {
    const body = await readJsonBody(request)
    if (body === undefined) return fail(400, 'bad-request', 'body must be JSON within the size limit')
    const sessionId = readSessionId(body)
    const seq = readSeq(body)
    if (sessionId === null || seq === null) return fail(400, 'bad-request', 'sessionId and seq are required')
    try {
      return ok(await service.preview(sessionId, seq))
    } catch (error) {
      return errorResponse(error)
    }
  }

  const apply = async (request) => {
    const body = await readJsonBody(request)
    if (body === undefined) return fail(400, 'bad-request', 'body must be JSON within the size limit')
    const sessionId = readSessionId(body)
    const seq = readSeq(body)
    const turn = readTurn(body)
    const mode = readMode(body)
    if (sessionId === null || mode === null || (seq === null && turn === null)) {
      return fail(400, 'bad-request', 'sessionId, a valid mode, and seq or turn are required')
    }
    try {
      return ok(await service.apply(sessionId, { seq, turn }, mode))
    } catch (error) {
      return errorResponse(error)
    }
  }

  const graph = async (request) => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (!SESSION_ID.test(sessionId)) return fail(400, 'bad-request', 'sessionId is required')
    const source = url.searchParams.get('source') === 'repo' ? 'repo' : 'checkpoints'
    const scope = url.searchParams.get('scope') === 'workspace' ? 'workspace' : 'session'
    const limit = Math.max(1, Math.min(500, Number.parseInt(url.searchParams.get('limit') ?? '200', 10) || 200))
    try {
      const cwd = await service.cwdForId(sessionId)
      if (!cwd) return fail(404, 'not-found', 'the session has no workspace directory')
      if (source === 'repo') {
        const status = await repoStatus(config, cwd)
        const commits = status.isRepo ? await repoLog(config, cwd, limit) : []
        return ok({ ...buildRepoGraph(status, commits, limit), workspace: cwd })
      }
      const indexes = (await store.listIndexes()).filter((index) => index.workspace !== '' && resolve(index.workspace) === resolve(cwd))
      // Sessions whose persisted log is gone (deleted) keep their checkpoints
      // for file recovery, but the graph labels them so rewind is understood
      // to be unavailable.
      const persistence = hostCtx?.get?.('sessionPersistence')
      const deletedIds = new Set()
      if (persistence && typeof persistence.stat === 'function') {
        for (const index of indexes) {
          try {
            const stat = await persistence.stat(index.sessionId)
            if (!stat) deletedIds.add(index.sessionId)
          } catch { /* treat as present */ }
        }
      }
      const live = service.liveSession(sessionId)
      const seqByTurn = new Map()
      if (live) {
        for (const anchor of listAnchors(live)) seqByTurn.set(anchor.turn, anchor.seq)
      }
      const graph = buildCheckpointGraph(indexes, { currentSessionId: sessionId, scope, limit, deletedIds })
      graph.commits = graph.commits.map((commit) => (
        commit.sessionId === sessionId && commit.seq === null && seqByTurn.has(commit.turn)
          ? { ...commit, seq: seqByTurn.get(commit.turn) }
          : commit
      ))
      return ok({ ...graph, workspace: cwd })
    } catch (error) {
      return errorResponse(error)
    }
  }

  const commit = async (request) => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const hash = url.searchParams.get('hash') ?? ''
    const source = url.searchParams.get('source') === 'repo' ? 'repo' : 'checkpoints'
    if (!SESSION_ID.test(sessionId)) return fail(400, 'bad-request', 'sessionId is required')
    if (!HASH.test(hash)) return fail(400, 'bad-request', 'invalid commit hash')
    try {
      const cwd = await service.cwdForId(sessionId)
      if (!cwd) return fail(404, 'not-found', 'the session has no workspace directory')
      if (source === 'repo') {
        return ok({ ...(await repoCommit(config, cwd, hash)), kind: 'repo' })
      }
      const indexes = await store.listIndexes()
      let found = null
      for (const index of indexes) {
        if (index.workspace === '' || resolve(index.workspace) !== resolve(cwd)) continue
        const record = index.checkpoints.find((item) => item.kind === 'turn' && item.commit === hash)
        if (record) { found = { index, record }; break }
      }
      if (!found) return fail(404, 'not-found', 'checkpoint not found')
      const live = service.liveSession(sessionId)
      const anchorByTurn = new Map(live ? listAnchors(live).map((anchor) => [anchor.turn, anchor.seq]) : [])
      const files = await store.commitFiles(cwd, found.record.commit, found.record.parent)
      return ok({
        kind: 'checkpoint',
        hash: found.record.commit,
        shortHash: String(found.record.commit).slice(0, 8),
        parents: found.record.parent ? [found.record.parent] : [],
        time: found.record.time,
        subject: found.record.preview || found.index.label || `会话 ${String(found.index.sessionId).slice(-6)}`,
        body: '',
        sessionId: found.index.sessionId,
        turn: found.record.turn,
        seq: found.record.seq ?? anchorByTurn.get(found.record.turn) ?? null,
        stats: found.record.stats,
        files,
      })
    } catch (error) {
      return errorResponse(error)
    }
  }

  const diff = async (request) => {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId') ?? ''
    const hash = url.searchParams.get('hash') ?? ''
    const path = url.searchParams.get('path') ?? ''
    const source = url.searchParams.get('source') === 'repo' ? 'repo' : 'checkpoints'
    if (!SESSION_ID.test(sessionId)) return fail(400, 'bad-request', 'sessionId is required')
    if (!HASH.test(hash)) return fail(400, 'bad-request', 'invalid commit hash')
    if (typeof path !== 'string' || path === '' || path.length > 4096) return fail(400, 'bad-request', 'path is required')
    try {
      const cwd = await service.cwdForId(sessionId)
      if (!cwd) return fail(404, 'not-found', 'the session has no workspace directory')
      if (source === 'repo') {
        return ok(await repoDiff(config, cwd, hash, path, config.diffMaxBytes || 262144))
      }
      const indexes = await store.listIndexes()
      const record = indexes
        .filter((index) => index.workspace !== '' && resolve(index.workspace) === resolve(cwd))
        .flatMap((index) => index.checkpoints)
        .find((item) => item.kind === 'turn' && item.commit === hash)
      if (!record) return fail(404, 'not-found', 'checkpoint not found')
      const files = await store.commitFiles(cwd, record.commit, record.parent)
      if (!files.some((file) => file.path === path)) return fail(404, 'not-found', 'file is not part of this commit')
      return ok(await store.commitPatch(cwd, record.commit, path, config.diffMaxBytes || 262144))
    } catch (error) {
      return errorResponse(error)
    }
  }

  const disposers = [
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/preview`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: preview,
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/apply`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: apply,
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/graph`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: graph,
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/commit`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: commit,
    }),
    connectionFetch.register({
      path: `${ROUTE_PREFIX}/diff`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: diff,
    }),
  ]
  return async () => {
    for (const dispose of disposers) await dispose()
  }
}
