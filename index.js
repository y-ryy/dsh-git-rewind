/**
 * Host half of dsh-git-rewind.
 *
 * It records one Git checkpoint per turn before the model can touch files,
 * exposes `/rewind`, and serves the sidebar graph plus preview/apply routes.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { compactionBoundary, findAnchorSeqForTurn, listAnchors, messageText, previewText } from './src/anchors.js'
import { GitStore } from './src/git-store.js'
import { registerGitRewindProjection } from './src/projection.js'
import { RewindError, RewindService } from './src/rewind-service.js'
import { registerRoutes } from './src/routes.js'

export const inject = ['commands', 'sessions']

const DEFAULT_CONFIG = {
  enabled: true,
  gitPath: 'git',
  snapshotTimeoutMs: 15000,
  previewLimit: 500,
  checkpointGraphLimit: 200,
  repoGraphLimit: 200,
  diffMaxBytes: 262144,
  exclude: [],
  prefillComposer: true,
}

const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

function formatTime(ms) {
  return Number.isFinite(ms) && ms > 0 ? TIME_FORMAT.format(new Date(ms)) : '-'
}

function parseCommand(raw) {
  const tokens = String(raw ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { action: 'list' }
  let index = 0
  if (tokens[index] === 'preview') index += 1
  const number = Number.parseInt(tokens[index] ?? '', 10)
  if (!Number.isSafeInteger(number) || number < 1) return { action: 'list', invalid: true }
  const flags = new Set(tokens.slice(index + 1))
  if (flags.has('--messages')) return { action: 'apply', n: number, mode: 'messages' }
  if (flags.has('--files')) return { action: 'apply', n: number, mode: 'both' }
  if (flags.has('--files-only')) return { action: 'apply', n: number, mode: 'files' }
  return { action: 'preview', n: number }
}

function formatFileSummary(preview) {
  const summary = preview.summary ?? {}
  if (!preview.checkpoint) return '文件：该消息没有 Git 检查点（只能撤回消息）。'
  if ((preview.files ?? []).length === 0) return '文件：检查点与当前工作区一致，无需还原。'
  return `文件：修改 ${summary.changed ?? 0}，新增 ${summary.added ?? 0}，删除 ${summary.deleted ?? 0}；共 +${summary.additions ?? 0} / -${summary.deletions ?? 0} 行。`
}

export function apply(ctx, rawConfig = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...rawConfig,
    storageDir: rawConfig.storageDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-git-rewind'),
  }
  if (config.enabled === false) return

  const store = new GitStore(config, ctx)
  const service = new RewindService(ctx, config, store)
  const seenTurns = new Map()

  ctx.effect(() => {
    const dispose = ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const session = ctx.sessions.get(payload.agent.id)
        if (session && session.header.origin !== 'subagent') {
          const seen = seenTurns.get(session.id) ?? new Set()
          seenTurns.set(session.id, seen)
          if (!seen.has(payload.turn)) {
            seen.add(payload.turn)
            const cwd = service.cwdFor(session)
            if (cwd && session.header.cwd) {
              const seq = findAnchorSeqForTurn(session, payload.turn)
              const opening = Array.isArray(payload.messages) ? payload.messages[0] : undefined
              const label = opening
                ? previewText(messageText({ data: opening }))
                : (seq === null ? '' : previewText(messageText(session.eventAt(seq))))
              await store.captureTurn({
                sessionId: session.id,
                cwd,
                turn: payload.turn,
                seq,
                label,
                parentSession: session.header.parentSession ?? null,
              })
            }
          }
        }
      } catch (error) {
        // A checkpoint failure must never reject the user's turn.
        console.warn('[dsh-git-rewind] checkpoint failed:', error instanceof Error ? error.message : error)
      }
      return next()
    })
    return dispose
  }, 'dsh-git-rewind: checkpoint before each turn')

  const registerCommand = (name) => ctx.commands.register({
    name,
    description: '撤回一条已发送的消息；可选还原该轮之前的 Git 文件检查点。',
    input: { hint: '[n] [--messages | --files | --files-only]' },
    handler: async (invocation) => {
      try {
        const session = ctx.sessions.get(invocation.agent.id) ?? await service.sessionFor(invocation.agent.id)
        const parsed = parseCommand(invocation.rawInput)
        if (parsed.action === 'list') {
          const anchors = listAnchors(session).slice(0, 20)
          if (anchors.length === 0) {
            return { kind: 'success', text: '没有可回退的用户消息。' + (compactionBoundary(session) === null ? '' : '（更早的内容已被压缩，无法撤回。）') }
          }
          const lines = anchors.map((anchor) => `${anchor.n}. [第 ${anchor.turn ?? '?'} 轮 · ${formatTime(anchor.time)}] ${anchor.preview || '（仅附件消息）'}`)
          return {
            kind: 'success',
            text: [
              '可回退的消息（最新在前）：',
              ...lines,
              '',
              '使用 /rewind <n> 预览；/rewind <n> --messages 仅撤回消息；/rewind <n> --files 同时还原文件。',
            ].join('\n'),
          }
        }

        const anchor = listAnchors(session)[parsed.n - 1]
        if (!anchor) {
          return { kind: 'error', text: `没有第 ${parsed.n} 条可回退消息。` }
        }
        if (parsed.action === 'preview') {
          const preview = await service.preview(session.id, anchor.seq)
          return {
            kind: 'success',
            text: [
              `预览：第 ${parsed.n} 条消息（第 ${anchor.turn ?? '?'} 轮，${formatTime(anchor.time)}）`,
              preview.prompt || '（仅附件消息）',
              formatFileSummary(preview),
              preview.checkpoint ? `检查点：${preview.checkpoint.commit.slice(0, 8)}` : '检查点：无',
              '确认执行：/rewind ' + parsed.n + ' --messages（仅消息）或 /rewind ' + parsed.n + ' --files（消息 + 文件）。',
            ].join('\n'),
          }
        }
        const result = await service.apply(session.id, anchor.seq, parsed.mode)
        return {
          kind: 'success',
          text: [
            result.recalled ? '消息已撤回，原文已准备回填。' : '未改动对话。',
            result.restored > 0 ? `已还原 ${result.restored} 个文件。` : '',
            result.quarantined?.length ? `隔离 ${result.quarantined.length} 个被替换/新增的文件。` : '',
            result.warnings?.length ? `提示：${result.warnings.join('；')}` : '',
          ].filter(Boolean).join('\n'),
        }
      } catch (error) {
        if (error instanceof RewindError) return { kind: 'error', text: error.message }
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  ctx.effect(() => {
    try {
      return registerCommand('rewind')
    } catch {
      return registerCommand('git-rewind')
    }
  }, 'dsh-git-rewind: command')

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.effect(() => registerGitRewindProjection(projectionCtx.sessionProjections), 'dsh-git-rewind: projection')
  })

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () => registerRoutes(connectionCtx.connection.fetch, service, store, config, ctx),
      'dsh-git-rewind: routes',
    )
  })
}
