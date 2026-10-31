/** One rewind operation shared by the slash command, the dialog and the sidebar. */
import { resolve } from 'node:path'
import { compactionBoundary, findAnchorBySeq, findAnchorSeqForTurn, listAnchors, planCut, placeholderData, previewText, messageText } from './anchors.js'
import { GitStoreError } from './git-store.js'

export class RewindError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'RewindError'
    this.code = code
    this.details = details
  }
}

const MODES = new Set(['messages', 'files', 'both'])

export class RewindService {
  constructor(ctx, config, store) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.locks = new Map()
  }

  async sessionFor(sessionId) {
    const live = this.ctx.sessions.get(sessionId)
    if (live) return live
    const controller = this.ctx.get('sessionController')
    if (!controller) throw new RewindError('not-found', `session not found: ${sessionId}`)
    const resolved = await controller.resolveAgent(sessionId)
    if (resolved?.error) {
      const code = resolved.error.code === 'session/agent-busy' ? 'busy' : 'not-found'
      throw new RewindError(code, resolved.error.message ?? 'session is not available')
    }
    const session = this.ctx.sessions.get(resolved.agent.id)
    if (!session) throw new RewindError('not-found', `session not found: ${sessionId}`)
    return session
  }

  liveSession(sessionId) {
    return this.ctx.sessions.get(sessionId)
  }

  cwdFor(session) {
    if (!session) return ''
    return this.ctx.get('workingDirectory')?.get(session) ?? session.header.cwd ?? ''
  }

  async cwdForId(sessionId) {
    const live = this.ctx.sessions.get(sessionId)
    if (live) return this.cwdFor(live)
    const indexes = await this.store.listIndexes()
    return indexes.find((index) => index.sessionId === sessionId)?.workspace ?? ''
  }

  assertIdle(session) {
    const events = session.snapshotEvents(0, session.seq)
    let lastStart = -1
    let lastEnd = -1
    for (const event of events) {
      if (event.type === 'turn/start') lastStart = event.seq
      else if (event.type === 'turn/end') lastEnd = event.seq
    }
    if (lastStart > lastEnd) {
      throw new RewindError('busy', 'the session is running; wait for the current turn to finish')
    }
  }

  /**
   * A file restore rewrites the whole shared workspace tree. Refuse while any
   * OTHER live session in the same directory is mid-turn: its next write would
   * race the restore, and files it already changed would be reverted under it.
   */
  assertWorkspaceIdle(sessionId, cwd) {
    const agents = this.ctx.get('agents')
    if (!agents || typeof agents.list !== 'function') return
    for (const agent of agents.list()) {
      if (agent.id === sessionId) continue
      const other = this.ctx.sessions.get(agent.id)
      if (!other) continue
      const otherCwd = this.cwdFor(other)
      if (!otherCwd || resolve(otherCwd) !== resolve(cwd)) continue
      let lastStart = -1
      let lastEnd = -1
      for (const event of other.snapshotEvents(0, other.seq)) {
        if (event.type === 'turn/start') lastStart = event.seq
        else if (event.type === 'turn/end') lastEnd = event.seq
      }
      if (lastStart > lastEnd) {
        throw new RewindError('busy', 'another session in this workspace is running; wait for it to finish before restoring files')
      }
    }
  }

  list(session) {
    const anchors = listAnchors(session).map((anchor) => ({
      n: anchor.n,
      seq: anchor.seq,
      turn: anchor.turn,
      time: anchor.time,
      preview: anchor.preview,
    }))
    return {
      sessionId: session.id,
      anchors,
      stoppedAtCompaction: compactionBoundary(session) !== null,
    }
  }

  async preview(sessionId, seq) {
    const session = await this.sessionFor(sessionId)
    const anchor = findAnchorBySeq(session, seq)
    if (!anchor) throw new RewindError('not-found', 'this message is not a recall anchor')
    this.assertIdle(session)
    const cut = planCut(session, anchor.n)
    if (cut.reason) throw new RewindError(cut.reason, this.describePlanFailure(cut))
    const cwd = this.cwdFor(session)
    if (!cwd) throw new RewindError('no-workspace', 'the session has no workspace directory')
    let filePreview
    try {
      filePreview = await this.store.preview(sessionId, cwd, cut.turn)
    } catch (error) {
      filePreview = {
        checkpoint: null,
        files: [],
        summary: { changed: 0, added: 0, deleted: 0, additions: 0, deletions: 0 },
        coverage: 'none',
        warnings: [error instanceof Error ? error.message : String(error)],
      }
    }
    return {
      prompt: cut.prompt,
      anchor: { n: cut.n, seq: anchor.seq, turn: anchor.turn, time: anchor.time },
      checkpoint: filePreview.checkpoint,
      files: filePreview.files.slice(0, this.config.previewLimit || 500),
      summary: filePreview.summary,
      coverage: filePreview.coverage,
      warnings: filePreview.warnings,
      gitAvailable: filePreview.checkpoint !== null,
      totalFiles: filePreview.files.length,
      prefillComposer: this.config.prefillComposer !== false,
    }
  }

  /**
   * @param {string} sessionId
   * @param {{seq?: number|null, turn?: number|null}} target - `seq` addresses a
   *   recall anchor (needed for messages modes); `turn` addresses a checkpoint
   *   directly (enough for files-only, including deleted sessions).
   * @param {'messages'|'files'|'both'} mode
   */
  async apply(sessionId, target = {}, mode = 'both') {
    if (!MODES.has(mode)) throw new RewindError('bad-request', `unknown mode: ${mode}`)
    const seq = typeof target?.seq === 'number' && Number.isSafeInteger(target.seq) ? target.seq : null
    const turn = typeof target?.turn === 'number' && Number.isSafeInteger(target.turn) && target.turn >= 0 ? target.turn : null
    const previous = this.locks.get(sessionId) ?? Promise.resolve()
    let release
    const current = new Promise((resolveLock) => { release = resolveLock })
    const queued = previous.then(() => current)
    this.locks.set(sessionId, queued)
    await previous
    try {
      // A deleted session has no live agent and no persisted log, but its
      // checkpoint index (and therefore its workspace) remains. Files-only
      // restore stays available for it; every other mode needs the session.
      let session = null
      try {
        session = await this.sessionFor(sessionId)
      } catch (error) {
        if (error.code !== 'not-found') throw error
      }
      if (!session && mode !== 'files') {
        throw new RewindError('not-found', `session not found: ${sessionId}`)
      }

      const cwd = session ? this.cwdFor(session) : await this.cwdForId(sessionId)
      if (!cwd) throw new RewindError('no-workspace', 'the session has no workspace directory')
      if (session) this.assertIdle(session)
      if (mode === 'files' || mode === 'both') {
        await this.assertWorkspaceIdle(sessionId, cwd)
      }

      let cut = null
      if (mode === 'messages' || mode === 'both') {
        const anchor = findAnchorBySeq(session, seq)
        if (!anchor) throw new RewindError('not-found', 'this message is not a recall anchor')
        cut = planCut(session, anchor.n)
        if (cut.reason) throw new RewindError(cut.reason, this.describePlanFailure(cut))
      }

      let restoreTurn = cut?.turn ?? turn
      if ((mode === 'files' || mode === 'both') && restoreTurn === null && seq !== null && session) {
        restoreTurn = findAnchorBySeq(session, seq)?.turn ?? null
      }
      if ((mode === 'files' || mode === 'both') && restoreTurn === null) {
        throw new RewindError('no-checkpoint', 'no turn was resolved for the file restore')
      }

      let fileResult = null
      if (mode === 'messages' || mode === 'both') {
        try {
          session.append('user/message', placeholderData(), {
            surfaceOp: { op: 'replace', startSeq: cut.startSeq, endSeq: cut.endSeq },
            sourceEventSeqs: cut.shadowedSeqs,
          })
        } catch (error) {
          throw new RewindError('writer-held', error instanceof Error ? error.message : String(error))
        }
        try { await this.ctx.sessions.flush(session) } catch { /* persistence drains later */ }
      }

      if (mode === 'files' || mode === 'both') {
        try {
          fileResult = await this.store.restore(sessionId, cwd, restoreTurn)
        } catch (error) {
          if (mode === 'both') {
            throw new RewindError('file-restore-failed', 'the message was recalled, but file restore failed', {
              recalled: true,
              prompt: cut.prompt,
              reason: error instanceof Error ? error.message : String(error),
            })
          }
          throw error instanceof GitStoreError
            ? new RewindError(error.code, error.message)
            : new RewindError('file-restore-failed', error instanceof Error ? error.message : String(error))
        }
      }

      return {
        recalled: mode === 'messages' || mode === 'both',
        prompt: cut?.prompt ?? '',
        turn: restoreTurn,
        restored: fileResult?.restored ?? 0,
        quarantined: fileResult?.quarantined ?? [],
        rescueId: fileResult?.rescueId ?? null,
        warnings: fileResult?.warnings ?? [],
      }
    } finally {
      release()
      if (this.locks.get(sessionId) === queued) this.locks.delete(sessionId)
    }
  }

  describePlanFailure(failure) {
    if (failure.reason === 'empty') return 'there are no recallable user messages'
    if (failure.reason === 'outOfRange') return `there is no message number ${failure.available + 1}; available: ${failure.available}`
    if (failure.reason === 'compactionBoundary') return 'the conversation was compacted before this point, so the message is no longer recallable'
    return 'the selected message is not a user prompt'
  }

  anchorPreview(session, turn) {
    const seq = findAnchorSeqForTurn(session, turn)
    if (seq === null) return ''
    const event = session.eventAt(seq)
    return previewText(messageText(event))
  }
}
