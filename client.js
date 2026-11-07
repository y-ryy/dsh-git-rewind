window.__ModuleLoader__.load({
  id: 'dsh-git-rewind',
  factory(require) {
    const React = require('react')
    const { useEffect, useMemo, useRef, useState, useSyncExternalStore, Fragment } = React
    const h = React.createElement
    const NS = 'dsh-git-rewind'
    const ROUTE = '/api/plugins/dsh-git-rewind'
    const LANE_W = 14
    const ROW_H = 36
    const PALETTE = ['#4c8dff', '#7b5cff', '#2bb673', '#f59e0b', '#14b8a6', '#ec4899', '#8b5cf6', '#ef4444']

    // ---------------------------------------------------------------------
    // Pure graph layout (also exported under __test for Node unit tests)
    // ---------------------------------------------------------------------
    function layoutGraph(commits) {
      const rows = []
      let lanes = []
      let laneColors = []
      let freed = []
      let nextColor = 0
      const openColor = () => {
        if (freed.length > 0) return freed.shift()
        const color = nextColor
        nextColor += 1
        return color
      }
      const freeColor = (color) => {
        if (color !== null && color !== undefined && !freed.includes(color)) freed.push(color)
      }
      for (const commit of commits) {
        const awaited = lanes.findIndex((hash) => hash === commit.hash)
        const awaitedBefore = awaited !== -1
        let lane = awaited
        if (lane === -1) {
          lane = lanes.findIndex((hash) => hash === null)
          if (lane === -1) {
            lane = lanes.length
            lanes.push(null)
            laneColors.push(null)
          }
          lanes[lane] = commit.hash
          laneColors[lane] = openColor()
        }
        const color = laneColors[lane]
        const before = lanes.slice()
        const beforeColors = laneColors.slice()
        for (let index = 0; index < lanes.length; index += 1) {
          if (index !== lane && lanes[index] === commit.hash) {
            freeColor(laneColors[index])
            lanes[index] = null
            laneColors[index] = null
          }
        }
        let continueLane = -1
        const extraLanes = []
        const parents = commit.parents ?? []
        if (parents.length === 0) {
          freeColor(laneColors[lane])
          lanes[lane] = null
          laneColors[lane] = null
        } else {
          const first = parents[0]
          const other = lanes.findIndex((hash, index) => hash === first && index !== lane)
          if (other === -1) {
            lanes[lane] = first
            continueLane = lane
          } else {
            const keep = Math.min(lane, other)
            const drop = Math.max(lane, other)
            lanes[keep] = first
            freeColor(laneColors[drop])
            lanes[drop] = null
            laneColors[drop] = null
            continueLane = keep
          }
          for (let index = 1; index < parents.length; index += 1) {
            let target = lanes.findIndex((hash) => hash === null)
            if (target === -1) {
              target = lanes.length
              lanes.push(null)
              laneColors.push(null)
            }
            lanes[target] = parents[index]
            laneColors[target] = openColor()
            extraLanes.push(target)
          }
        }
        const edges = []
        for (let index = 0; index < before.length; index += 1) {
          const awaitedHash = before[index]
          if (awaitedHash === null || awaitedHash === undefined) continue
          if (awaitedHash === commit.hash) {
            if (index === lane && !awaitedBefore) continue
            edges.push({ from: index, to: lane, color: beforeColors[index], kind: 'into' })
          } else {
            const target = lanes[index] === awaitedHash ? index : lanes.findIndex((hash) => hash === awaitedHash)
            if (target !== -1) edges.push({ from: index, to: target, color: beforeColors[index], kind: 'pass' })
          }
        }
        if (continueLane !== -1) {
          edges.push({ from: lane, to: continueLane, color: laneColors[continueLane], kind: 'out' })
        }
        for (const target of extraLanes) {
          edges.push({ from: lane, to: target, color: laneColors[target], kind: 'out' })
        }
        rows.push({ commit, lane, color, edges })
        while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
          lanes = lanes.slice(0, -1)
          laneColors = laneColors.slice(0, -1)
        }
      }
      return rows
    }

    function graphWidth(rows) {
      let max = 0
      for (const row of rows) {
        max = Math.max(max, row.lane + 1)
        for (const edge of row.edges) max = Math.max(max, edge.from + 1, edge.to + 1)
      }
      return Math.max(1, max)
    }

    function relativeTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const delta = Date.now() - ms
      if (delta < 60_000) return '刚刚'
      if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
      if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
      return new Date(ms).toLocaleDateString()
    }

    // ---------------------------------------------------------------------
    // API + tiny dialog store
    // ---------------------------------------------------------------------
    async function api(path, init) {
      const response = await fetch(`${ROUTE}${path}`, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      let body
      try { body = await response.json() } catch { body = null }
      if (!response.ok || !body || body.ok !== true) {
        const error = new Error(body?.error?.message ?? `请求失败（${response.status}）`)
        error.code = body?.error?.code ?? 'http-error'
        error.details = body?.error?.details
        throw error
      }
      return body.value
    }

    let dialogState = {
      open: false,
      sessionId: '',
      seq: null,
      mode: 'both',
      inputActions: null,
      prompt: '',
    }
    const dialogListeners = new Set()
    function emitDialog() {
      for (const listener of dialogListeners) listener()
    }
    function openRewindDialog(next) {
      dialogState = { ...dialogState, ...next, open: true }
      emitDialog()
    }
    function closeRewindDialog() {
      dialogState = { ...dialogState, open: false }
      emitDialog()
    }
    function useDialogState() {
      return useSyncExternalStore(
        (listener) => { dialogListeners.add(listener); return () => dialogListeners.delete(listener) },
        () => dialogState,
        () => dialogState,
      )
    }

    function setComposerText(actions, text) {
      if (!actions || typeof text !== 'string') return false
      for (const method of ['setDraft', 'setText', 'replaceDraft']) {
        if (typeof actions[method] === 'function') {
          try {
            actions[method](text)
            if (typeof actions.persistDraft === 'function') actions.persistDraft()
            return true
          } catch { /* try the next shape */ }
        }
      }
      return false
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    // ---------------------------------------------------------------------
    // Dictionaries
    // ---------------------------------------------------------------------
    const ZH = {
      'panel.title': 'Git 版本',
      'panel.tab.checkpoints': '回退检查点',
      'panel.tab.repo': '仓库历史',
      'panel.search': '搜索消息、提交或哈希…',
      'panel.refresh': '刷新',
      'panel.scope.session': '仅当前会话',
      'panel.scope.workspace': '全部会话',
      'panel.empty.checkpoints': '还没有检查点。发送一条消息后会自动创建。',
      'panel.empty.repo': '当前目录不是 Git 仓库。检查点功能仍然可用。',
      'panel.empty.search': '没有匹配的提交。',
      'panel.loading': '正在读取 Git 数据…',
      'panel.current': '当前',
      'panel.skipped': '无检查点',
      'panel.deleted': '已删除',
      'panel.fork': '分支',
      'panel.detail.files': '文件变更',
      'panel.detail.noFiles': '没有文件变更',
      'panel.action.rewind': '回退到此处',
      'panel.action.files': '仅还原文件',
      'panel.action.copy': '复制 commit',
      'panel.action.copied': '已复制',
      'panel.status.checkpoints': '{sessions} 个会话 · {commits} 个检查点',
      'panel.status.repo': '{branch} · ↑{ahead} ↓{behind} · {dirty} 个未提交变更',
      'panel.status.noRepo': '非 Git 仓库',
      'panel.detail.loading': '读取提交详情…',
      'panel.detail.commit': '提交',
      'panel.detail.time': '时间',
      'panel.detail.author': '作者',
      'panel.detail.parent': '父提交',
      'panel.diff.loading': '读取 diff…',
      'panel.diff.empty': '该文件没有可显示的文本差异。',
      'dialog.title': '撤回消息',
      'dialog.message': '消息',
      'dialog.files': '文件变更',
      'dialog.noFiles': '这条消息没有文件检查点，或者工作区没有变化。',
      'dialog.mode.messages': '仅撤回消息',
      'dialog.mode.both': '撤回消息并还原文件',
      'dialog.mode.files': '仅还原文件（不改动对话）',
      'dialog.confirm': '确认撤回',
      'dialog.cancel': '取消',
      'dialog.busy': '正在处理…',
      'dialog.restoring': '正在还原文件…',
      'dialog.done': '已完成，原文已放回输入框。',
      'dialog.prefillFailed': '已完成，但输入框回填失败；原文已复制到剪贴板。',
      'dialog.recalledNoFiles': '消息已撤回，但文件还原失败：{reason}',
      'dialog.filesSummary': '修改 {changed} · 新增 {added} · 删除 {deleted} · +{additions} / -{deletions}',
      'dialog.loadingPreview': '正在检查文件和检查点…',
      'dialog.close': '关闭',
      'dialog.cancelHint': '消息原文会回到输入框，可修改后重新发送。',
      'dialog.deletedOnly': '该会话已被删除：消息无法撤回，但仍可将工作区文件还原到这个检查点（同样会先创建救援点并隔离现有文件）。',
      'error.busy': '当前会话正在运行，请等这一轮结束后再回退。',
      'error.compactionBoundary': '目标消息早于最近一次压缩，已经无法撤回。',
      'error.noCheckpoint': '这条消息没有文件检查点，只能撤回消息。',
      'error.gitUnavailable': '当前环境找不到 Git，文件还原不可用。',
      'error.writerHeld': '会话被另一个进程占用，回退请求没有执行。',
      'error.pathRejected': '还原路径未通过安全检查。',
      'error.fileRestoreFailed': '消息已撤回，但文件还原失败。',
      'error.generic': '操作失败：{message}',
    }
    const EN = {
      'panel.title': 'Git Versions',
      'panel.tab.checkpoints': 'Checkpoints',
      'panel.tab.repo': 'Repository',
      'panel.search': 'Search messages, commits or hashes…',
      'panel.refresh': 'Refresh',
      'panel.scope.session': 'This session',
      'panel.scope.workspace': 'All sessions',
      'panel.empty.checkpoints': 'No checkpoints yet. Send a message to create one.',
      'panel.empty.repo': 'This directory is not a Git repository. Checkpoints still work.',
      'panel.empty.search': 'No matching commits.',
      'panel.loading': 'Reading Git data…',
      'panel.current': 'current',
      'panel.skipped': 'no checkpoint',
      'panel.deleted': 'deleted',
      'panel.fork': 'fork',
      'panel.detail.files': 'Changed files',
      'panel.detail.noFiles': 'No file changes',
      'panel.action.rewind': 'Rewind here',
      'panel.action.files': 'Restore files only',
      'panel.action.copy': 'Copy commit',
      'panel.action.copied': 'Copied',
      'panel.status.checkpoints': '{sessions} sessions · {commits} checkpoints',
      'panel.status.repo': '{branch} · ↑{ahead} ↓{behind} · {dirty} uncommitted',
      'panel.status.noRepo': 'Not a Git repository',
      'panel.detail.loading': 'Reading commit…',
      'panel.detail.commit': 'Commit',
      'panel.detail.time': 'Time',
      'panel.detail.author': 'Author',
      'panel.detail.parent': 'Parent',
      'panel.diff.loading': 'Reading diff…',
      'panel.diff.empty': 'No textual diff for this file.',
      'dialog.title': 'Recall message',
      'dialog.message': 'Message',
      'dialog.files': 'Changed files',
      'dialog.noFiles': 'This message has no file checkpoint, or the workspace has not changed.',
      'dialog.mode.messages': 'Recall messages only',
      'dialog.mode.both': 'Recall and restore files',
      'dialog.mode.files': 'Restore files only (keep conversation)',
      'dialog.confirm': 'Recall',
      'dialog.cancel': 'Cancel',
      'dialog.busy': 'Working…',
      'dialog.restoring': 'Restoring files…',
      'dialog.done': 'Done. The original text is back in the composer.',
      'dialog.prefillFailed': 'Done, but the composer could not be filled; the text is on your clipboard.',
      'dialog.recalledNoFiles': 'Messages were recalled, but file restore failed: {reason}',
      'dialog.filesSummary': '{changed} modified · {added} added · {deleted} deleted · +{additions} / -{deletions}',
      'dialog.loadingPreview': 'Checking files and checkpoints…',
      'dialog.close': 'Close',
      'dialog.cancelHint': 'The original text returns to the composer so you can edit and send it again.',
      'dialog.deletedOnly': 'This session was deleted: messages cannot be recalled, but the workspace files can still be restored to this checkpoint (a rescue point is created and current files are quarantined first).',
      'error.busy': 'This session is running; wait for the current turn to finish.',
      'error.compactionBoundary': 'This message is older than the latest compaction and cannot be recalled.',
      'error.noCheckpoint': 'This message has no file checkpoint; only the messages can be recalled.',
      'error.gitUnavailable': 'Git is not available, so file restore is disabled.',
      'error.writerHeld': 'Another process owns this session; the request did not run.',
      'error.pathRejected': 'A restore path failed the safety check.',
      'error.fileRestoreFailed': 'Messages were recalled, but file restore failed.',
      'error.generic': 'Operation failed: {message}',
    }

    function translate(t, key, params) {
      let text = t(key)
      if (params) {
        for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
      }
      return text
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------
    const CSS = `
      .dgr-root, .dgr-modal, .dgr-panel { box-sizing: border-box; }
      .dgr-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--dsw-alias-label-primary, #1f2937); font-size: 12px; }
      .dgr-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; flex-wrap: wrap; }
      .dgr-title { font-size: 13px; font-weight: 600; margin-right: auto; }
      .dgr-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
      .dgr-tab { border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #6b7280); padding: 4px 8px; border-radius: 6px; cursor: pointer; font: inherit; }
      .dgr-tab.dgr-active { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #111827); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
      .dgr-status { display: flex; gap: 8px; align-items: center; padding: 0 12px 6px; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11px; flex-wrap: wrap; }
      .dgr-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); color: var(--dsw-alias-label-secondary, #6b7280); }
      .dgr-toolbar { display: flex; gap: 6px; align-items: center; padding: 0 12px 8px; }
      .dgr-search { flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); border-radius: 7px; background: transparent; color: inherit; padding: 5px 8px; font: inherit; outline: none; }
      .dgr-btn { border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); border-radius: 7px; background: transparent; color: inherit; padding: 4px 8px; cursor: pointer; font: inherit; white-space: nowrap; }
      .dgr-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
      .dgr-btn:disabled { opacity: .45; cursor: default; }
      .dgr-btn.dgr-primary { background: var(--dsw-alias-state-business-primary, #2563eb); border-color: transparent; color: #fff; }
      .dgr-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: auto; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); }
      .dgr-panel.dgr-wide .dgr-body { flex-direction: row; overflow: hidden; }
      .dgr-graph-pane { min-width: 0; flex: 1; overflow: auto; }
      .dgr-detail { flex: 0 0 300px; min-width: 0; border-left: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); overflow: auto; padding: 10px 12px 16px; }
      .dgr-narrow .dgr-detail { flex: none; border-left: 0; border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); max-height: 46%; }
      .dgr-row { display: flex; gap: 6px; align-items: stretch; min-height: ${ROW_H}px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.12)); cursor: pointer; }
      .dgr-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)); }
      .dgr-row.dgr-selected { background: var(--dsw-alias-interactive-bg-active, rgba(76,141,255,.12)); }
      .dgr-graph { flex: 0 0 auto; }
      .dgr-row-body { flex: 1; min-width: 0; padding: 5px 8px 4px 0; display: flex; flex-direction: column; justify-content: center; gap: 2px; }
      .dgr-row-title { display: flex; align-items: center; gap: 5px; min-width: 0; }
      .dgr-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dgr-hash { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 10px; }
      .dgr-meta { display: flex; gap: 6px; align-items: center; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 10px; min-width: 0; }
      .dgr-badge { display: inline-flex; align-items: center; border-radius: 4px; padding: 1px 4px; font-size: 10px; line-height: 1.4; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); color: var(--dsw-alias-label-secondary, #6b7280); }
      .dgr-badge-current { background: rgba(37,99,235,.22); color: var(--dsw-alias-label-primary, #111827); }
      .dgr-badge-skip { background: rgba(245,158,11,.22); color: var(--dsw-alias-label-primary, #111827); }
      .dgr-badge-repo { background: rgba(139,92,246,.22); color: var(--dsw-alias-label-primary, #111827); }
      .dgr-empty { padding: 24px 16px; color: var(--dsw-alias-label-secondary, #6b7280); text-align: center; line-height: 1.6; }
      .dgr-detail-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 600; margin-bottom: 6px; }
      .dgr-detail-meta { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11px; line-height: 1.8; margin-bottom: 8px; }
      .dgr-detail-actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
      .dgr-files { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
      .dgr-file { display: flex; gap: 6px; align-items: center; padding: 3px 4px; border-radius: 5px; cursor: pointer; min-width: 0; }
      .dgr-file:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); }
      .dgr-file-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; }
      .dgr-status-m { color: var(--dsw-alias-label-primary, #111827); background: rgba(245,158,11,.25); border-radius: 3px; padding: 0 3px; font-weight: 600; }
      .dgr-status-a { color: var(--dsw-alias-label-primary, #111827); background: rgba(21,128,61,.25); border-radius: 3px; padding: 0 3px; font-weight: 600; }
      .dgr-status-d { color: var(--dsw-alias-label-primary, #111827); background: rgba(185,28,28,.25); border-radius: 3px; padding: 0 3px; font-weight: 600; }
      .dgr-status-r { color: var(--dsw-alias-label-primary, #111827); background: rgba(124,58,237,.25); border-radius: 3px; padding: 0 3px; font-weight: 600; }
      .dgr-diff { margin: 8px 0 0; padding: 8px; max-height: 260px; overflow: auto; white-space: pre; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; line-height: 1.5; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); border-radius: 6px; }
      .dgr-modal { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,.42); display: flex; align-items: center; justify-content: center; padding: 24px; }
      .dgr-modal-card { width: min(760px, 100%); max-height: 84vh; overflow: auto; background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #111827); border-radius: 12px; box-shadow: 0 24px 80px rgba(0,0,0,.35); padding: 16px 18px; }
      .dgr-modal-title { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
      .dgr-modal-sub { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11px; margin-bottom: 10px; }
      .dgr-prompt { white-space: pre-wrap; line-height: 1.55; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.1)); border-radius: 8px; padding: 8px 10px; max-height: 120px; overflow: auto; margin: 6px 0 10px; }
      .dgr-modes { display: flex; flex-direction: column; gap: 6px; margin: 8px 0 12px; }
      .dgr-mode { display: flex; gap: 6px; align-items: flex-start; padding: 7px 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25)); border-radius: 8px; cursor: pointer; }
      .dgr-mode.dgr-disabled { opacity: .5; cursor: default; }
      .dgr-mode input { margin-top: 2px; }
      .dgr-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
      .dgr-error { color: #b91c1c; white-space: pre-wrap; margin: 8px 0; }
      .dgr-note { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11px; margin-top: 6px; }
      .dgr-session-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
      /* Join the built-in user-message action row (time + Copy) instead of
         stacking a second row below the bubble. The built-in row's class names
         are build-hashed, but its stable semantic hook is [data-clock="start"]. */
      .dgr-msg-actions { position: absolute; right: 0; bottom: 0; display: flex; align-items: center; opacity: 1; }
      .dgr-msg-action { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-tertiary, #8a8f98); cursor: pointer; }
      [data-chat-flow-kind="user"] { position: relative; }
      [data-chat-flow-kind="user"] [data-clock="start"] { margin-right: 32px; }
      .dgr-msg-action:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12)); color: var(--dsw-alias-label-secondary, #5f6673); }
      .dgr-msg-action:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4c8dff)); outline-offset: 2px; }
    `

    function Styles() {
      return h('style', { 'data-dsh-git-rewind': '' }, CSS)
    }

    function hiddenTurnsStyle(wire) {
      const turns = wire?.hiddenTurns ?? []
      if (turns.length === 0) return null
      return h('style', {
        'data-dsh-git-rewind-hidden': '',
      }, turns.map((turn) => `[data-chat-turn="${turn}"]{display:none!important}`).join('\n'))
    }

    // ---------------------------------------------------------------------
    // Small shared pieces
    // ---------------------------------------------------------------------
    function PanelIcon({ size = 18 }) {
      return h('svg', {
        viewBox: '0 0 20 20', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('circle', { cx: 10, cy: 10, r: 7.1 }),
        h('path', { d: 'M10 6.4v4.1l2.8 1.7' }),
        h('path', { d: 'M4.2 4.2l1.8 1.8M15.8 4.2l-1.8 1.8' }),
      )
    }

    function GraphSvg({ row, laneCount }) {
      const width = Math.max(1, laneCount) * LANE_W
      const center = ROW_H / 2
      const paths = row.edges.map((edge, index) => {
        const x1 = edge.from * LANE_W + LANE_W / 2
        const x2 = edge.to * LANE_W + LANE_W / 2
        const y1 = edge.kind === 'into' ? 0 : edge.kind === 'out' ? center : 0
        const y2 = edge.kind === 'into' ? center : ROW_H
        const mid = (y1 + y2) / 2
        const d = x1 === x2
          ? `M ${x1} ${y1} L ${x2} ${y2}`
          : `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
        return h('path', {
          key: `e${index}`,
          d,
          stroke: PALETTE[(edge.color ?? 0) % PALETTE.length],
          strokeWidth: 1.6,
          fill: 'none',
          opacity: 0.78,
          'vector-effect': 'non-scaling-stroke',
        })
      })
      return h('svg', { width, height: ROW_H, viewBox: `0 0 ${width} ${ROW_H}`, 'aria-hidden': true },
        paths,
        h('circle', {
          cx: row.lane * LANE_W + LANE_W / 2,
          cy: center,
          r: 4,
          fill: PALETTE[(row.color ?? 0) % PALETTE.length],
          stroke: 'var(--dsw-alias-bg-layer-1, #fff)',
          strokeWidth: 1.5,
        }),
      )
    }

    function fileStatusLabel(status) {
      if (status === 'A') return 'A'
      if (status === 'D') return 'D'
      if (status === 'R') return 'R'
      if (status === 'T') return 'T'
      return 'M'
    }

    function fileStatusClass(status) {
      if (status === 'A') return 'dgr-status-a'
      if (status === 'D') return 'dgr-status-d'
      if (status === 'R') return 'dgr-status-r'
      return 'dgr-status-m'
    }

    // ---------------------------------------------------------------------
    // Rewind dialog
    // ---------------------------------------------------------------------
    function RewindDialogHost({ t }) {
      const state = useDialogState()
      return h(Fragment, null,
        h(Styles),
        state.open ? h(RewindDialog, { state, t }) : null,
      )
    }

    function RewindDialog({ state, t }) {
      const [preview, setPreview] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [mode, setMode] = useState(state.mode === 'files' ? 'files' : 'both')
      const [notice, setNotice] = useState('')
      const [recalled, setRecalled] = useState(false)
      const [deletedOnly, setDeletedOnly] = useState(false)

      useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        setPreview(null)
        setNotice('')
        setRecalled(false)
        setDeletedOnly(false)
        const seq = state.seq
        if (!state.sessionId || (seq === null || seq === undefined) && (state.turn === null || state.turn === undefined)) {
          setError('没有选中可回退的消息')
          setLoading(false)
          return () => { cancelled = true }
        }
        if (seq === null || seq === undefined) {
          // No anchor seq (deleted session): files-only restore by turn.
          setDeletedOnly(true)
          setMode('files')
          setLoading(false)
          return () => { cancelled = true }
        }
        api('/preview', {
          method: 'POST',
          body: JSON.stringify({ sessionId: state.sessionId, seq }),
        })
          .then((value) => {
            if (cancelled) return
            setPreview(value)
            setMode(value.checkpoint ? (state.mode === 'files' ? 'files' : 'both') : 'messages')
            setLoading(false)
          })
          .catch((reason) => {
            if (cancelled) return
            if (reason.code === 'not-found' && (state.turn !== null && state.turn !== undefined)) {
              // The session was deleted after the dialog opened: degrade to a
              // files-only confirm addressed by turn.
              setDeletedOnly(true)
              setMode('files')
              setLoading(false)
              return
            }
            setError(reason.message)
            setLoading(false)
          })
        return () => { cancelled = true }
      }, [state.sessionId, state.seq, state.turn])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && !busy) closeRewindDialog()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [busy])

      const confirm = async () => {
        if (busy) return
        if (deletedOnly) {
          // Deleted session: only the files restore is possible, addressed by
          // the checkpoint turn instead of a live-session anchor.
          if (state.turn === null || state.turn === undefined) return
          setBusy(true)
          setError(null)
          try {
            await api('/apply', {
              method: 'POST',
              body: JSON.stringify({ sessionId: state.sessionId, turn: state.turn, mode: 'files' }),
            })
            setNotice(t('dialog.done'))
            closeRewindDialog()
          } catch (reason) {
            setError(reason.message)
          } finally {
            setBusy(false)
          }
          return
        }
        if (!preview || busy) return
        setBusy(true)
        setError(null)
        try {
          const result = await api('/apply', {
            method: 'POST',
            body: JSON.stringify({ sessionId: state.sessionId, seq: state.seq, turn: state.turn ?? null, mode }),
          })
          const prompt = result.prompt ?? preview.prompt ?? ''
          const shouldPrefill = preview.prefillComposer !== false
          const applied = shouldPrefill ? setComposerText(state.inputActions, prompt) : false
          if (shouldPrefill && !applied && prompt) await copyText(prompt)
          setNotice(shouldPrefill && !applied ? t('dialog.prefillFailed') : t('dialog.done'))
          closeRewindDialog()
        } catch (reason) {
          if (reason.details?.recalled) {
            setRecalled(true)
            setNotice(translate(t, 'dialog.recalledNoFiles', { reason: reason.details.reason ?? reason.message }))
          } else {
            setError(reason.message)
          }
        } finally {
          setBusy(false)
        }
      }

      const summary = preview?.summary ?? { changed: 0, added: 0, deleted: 0, additions: 0, deletions: 0 }
      const hasCheckpoint = Boolean(preview?.checkpoint)
      const filesEnabled = deletedOnly ? true : hasCheckpoint
      const modes = [
        { key: 'messages', label: t('dialog.mode.messages'), enabled: !deletedOnly },
        { key: 'both', label: t('dialog.mode.both'), enabled: filesEnabled && !deletedOnly },
        { key: 'files', label: t('dialog.mode.files'), enabled: filesEnabled },
      ]

      return h('div', { className: 'dgr-modal', onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) closeRewindDialog() } },
        h('div', { className: 'dgr-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('dialog.title') },
          h(Styles),
          h('div', { className: 'dgr-modal-title' }, t('dialog.title')),
          h('div', { className: 'dgr-modal-sub' }, preview?.anchor ? `第 ${preview.anchor.n} 条 · 第 ${preview.anchor.turn ?? '?'} 轮` : deletedOnly && state.turn !== null && state.turn !== undefined ? `第 ${state.turn} 轮` : ''),
          loading ? h('div', { className: 'dgr-empty' }, t('dialog.loadingPreview')) : null,
          error ? h('div', { className: 'dgr-error' }, error) : null,
          notice ? h('div', { className: 'dgr-note' }, notice) : null,
          deletedOnly ? h('div', { className: 'dgr-note' }, t('dialog.deletedOnly')) : null,
          preview ? h(Fragment, null,
            h('div', { className: 'dgr-detail-meta' }, t('dialog.message')),
            h('div', { className: 'dgr-prompt' }, preview.prompt || '（仅附件消息）'),
            h('div', { className: 'dgr-detail-meta' }, t('dialog.files')),
            preview.files?.length
              ? h('div', { className: 'dgr-files' }, preview.files.slice(0, 30).map((file) =>
                h('div', { className: 'dgr-file', key: `${file.status}:${file.path}` },
                  h('span', { className: `dgr-hash ${fileStatusClass(file.status)}` }, fileStatusLabel(file.status)),
                  h('span', { className: 'dgr-file-path', title: file.path }, file.path),
                  h('span', { className: 'dgr-hash' }, file.binary ? 'bin' : `+${file.additions ?? 0} −${file.deletions ?? 0}`),
                )))
              : h('div', { className: 'dgr-note' }, t('dialog.noFiles')),
            preview.files?.length > 30 ? h('div', { className: 'dgr-note' }, `… ${preview.files.length - 30} more`) : null,
            h('div', { className: 'dgr-note' },
              translate(t, 'dialog.filesSummary', {
                changed: summary.changed,
                added: summary.added,
                deleted: summary.deleted,
                additions: summary.additions,
                deletions: summary.deletions,
              })),
            h('div', { className: 'dgr-modes' }, modes.map((item) =>
              h('label', { key: item.key, className: `dgr-mode${item.enabled ? '' : ' dgr-disabled'}` },
                h('input', {
                  type: 'radio',
                  name: 'dgr-mode',
                  checked: mode === item.key,
                  disabled: !item.enabled || busy,
                  onChange: () => item.enabled && setMode(item.key),
                }),
                h('span', null, item.label),
              ))),
            h('div', { className: 'dgr-note' }, t('dialog.cancelHint')),
          ) : null,
          h('div', { className: 'dgr-modal-actions' },
            h('button', { className: 'dgr-btn', onClick: () => closeRewindDialog(), disabled: busy }, t('dialog.cancel')),
            h('button', { className: 'dgr-btn dgr-primary', onClick: confirm, disabled: busy || loading || (!deletedOnly && !preview) || recalled }, busy ? t('dialog.busy') : t('dialog.confirm')),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Per-user-message action (next to the built-in Copy action)
    // ---------------------------------------------------------------------
    function RecallIcon({ size = 15 }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      },
        h('path', { d: 'M3.2 6.4h5.6a3.4 3.4 0 0 1 0 6.8H5.4' }),
        h('path', { d: 'M5.8 3.6 3 6.4l2.8 2.8' }),
      )
    }

    function findBuiltin(slots, key) {
      const entries = typeof slots?.entries === 'function' ? slots.entries('conversation.chat.node') : []
      const match = entries.find((entry) => entry.options?.key === key && (entry.options?.priority ?? 0) === 0)
        ?? entries.find((entry) => entry.options?.key === key)
      return match?.component
    }

    function makeMessageActionView(deps) {
      return function MessageActionView(props) {
        const [builtin, setBuiltin] = useState(() => findBuiltin(deps.slots, 'user'))
        useEffect(() => {
          if (builtin != null) return undefined
          let cancelled = false
          const timer = setInterval(() => {
            const found = findBuiltin(deps.slots, 'user')
            if (found == null || cancelled) return
            setBuiltin(found)
            clearInterval(timer)
          }, 250)
          return () => {
            cancelled = true
            clearInterval(timer)
          }
        }, [builtin])
        const wire = typeof props.useProjection === 'function' ? props.useProjection('gitRewind') : undefined
        const seq = typeof props.node?.anchorSeq === 'number' ? props.node.anchorSeq : undefined
        const anchor = seq === undefined ? undefined : wire?.anchors?.find((item) => item.seq === seq)
        if (builtin == null) return null
        const Builtin = builtin
        return h(Fragment, null,
          h(Builtin, props),
          hiddenTurnsStyle(wire),
          anchor && typeof props.sessionId === 'string' ? h('div', { className: 'dgr-msg-actions' },
            h('button', {
              type: 'button',
              className: 'dgr-msg-action',
              title: deps.t('dialog.title'),
              'aria-label': deps.t('dialog.title'),
              onClick: (event) => {
                event.stopPropagation()
                openRewindDialog({
                  sessionId: props.sessionId,
                  seq: anchor.seq,
                  mode: 'both',
                  inputActions: props.inputActions,
                })
              },
            }, h(RecallIcon, { size: 15 })),
          ) : null,
        )
      }
    }

    function FooterButton({ right, t }) {
      const open = () => {
        const sessionId = right?.mounted?.getSnapshot?.()
        if (typeof sessionId === 'string' && sessionId !== '') {
          try { right.openTab('git-rewind') } catch { /* no session pane yet */ }
        }
      }
      return h(Fragment, null,
        h(Styles),
        h('button', {
          type: 'button', className: 'dgr-btn', title: t('panel.title'), 'aria-label': t('panel.title'),
          onClick: open, style: { display: 'inline-flex', alignItems: 'center', gap: 5 },
        }, h(PanelIcon, { size: 16 }), h('span', null, t('panel.title'))),
      )
    }

    // ---------------------------------------------------------------------
    // Sidebar panel
    // ---------------------------------------------------------------------
    function useElementWidth(ref) {
      const [width, setWidth] = useState(0)
      useEffect(() => {
        const element = ref.current
        if (!element || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver((entries) => {
          const next = entries[0]?.contentRect?.width ?? 0
          setWidth(next)
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [ref])
      return width
    }

    function Panel({ sessionId, useProjection, inputActions, t }) {
      const wire = typeof useProjection === 'function' ? useProjection('gitRewind') : undefined
      const [source, setSource] = useState('checkpoints')
      const [scope, setScope] = useState('session')
      const [query, setQuery] = useState('')
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [selectedHash, setSelectedHash] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailLoading, setDetailLoading] = useState(false)
      const [diffPath, setDiffPath] = useState(null)
      const [diff, setDiff] = useState(null)
      const [diffLoading, setDiffLoading] = useState(false)
      const [refreshTick, setRefreshTick] = useState(0)
      const rootRef = useRef(null)
      const width = useElementWidth(rootRef)
      const anchorCount = wire?.anchors?.length ?? 0
      const hiddenCount = wire?.hiddenTurns?.length ?? 0

      useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        const url = `/graph?sessionId=${encodeURIComponent(sessionId)}&source=${source}&scope=${scope}&limit=200`
        api(url)
          .then((value) => {
            if (cancelled) return
            setData(value)
            setSelectedHash((current) => value.commits.some((commit) => commit.hash === current)
              ? current
              : (value.commits.find((commit) => !commit.skipped)?.hash ?? null))
            setLoading(false)
          })
          .catch((reason) => {
            if (cancelled) return
            setError(reason.message)
            setLoading(false)
          })
        return () => { cancelled = true }
      }, [sessionId, source, scope, anchorCount, hiddenCount, refreshTick])

      useEffect(() => {
        if (!selectedHash) { setDetail(null); return undefined }
        let cancelled = false
        setDetailLoading(true)
        api(`/commit?sessionId=${encodeURIComponent(sessionId)}&source=${source}&hash=${encodeURIComponent(selectedHash)}`)
          .then((value) => { if (!cancelled) { setDetail(value); setDetailLoading(false); setDiffPath(null); setDiff(null) } })
          .catch((reason) => { if (!cancelled) { setDetail(null); setDetailLoading(false); setError(reason.message) } })
        return () => { cancelled = true }
      }, [selectedHash, source, sessionId, refreshTick])

      useEffect(() => {
        if (!diffPath) { setDiff(null); return undefined }
        let cancelled = false
        setDiffLoading(true)
        api(`/diff?sessionId=${encodeURIComponent(sessionId)}&source=${source}&hash=${encodeURIComponent(selectedHash)}&path=${encodeURIComponent(diffPath)}`)
          .then((value) => { if (!cancelled) { setDiff(value); setDiffLoading(false) } })
          .catch((reason) => { if (!cancelled) { setDiff({ text: reason.message, truncated: false }); setDiffLoading(false) } })
        return () => { cancelled = true }
      }, [diffPath, sessionId, source, selectedHash])

      const commits = useMemo(() => {
        const list = data?.commits ?? []
        const needle = query.trim().toLowerCase()
        if (!needle) return list
        return list.filter((commit) =>
          String(commit.hash).toLowerCase().includes(needle)
          || String(commit.shortHash).toLowerCase().includes(needle)
          || String(commit.subject).toLowerCase().includes(needle)
          || String(commit.author ?? '').toLowerCase().includes(needle)
          || (commit.decorations ?? []).some((item) => String(item).toLowerCase().includes(needle)))
      }, [data, query])
      const rows = useMemo(() => layoutGraph(commits), [commits])
      const laneCount = graphWidth(rows)
      const wide = width >= 620
      const sessionsById = useMemo(() => new Map((data?.sessions ?? []).map((session) => [session.id, session])), [data])

      const refresh = () => setRefreshTick((value) => value + 1)

      const selectCommit = (commit) => {
        setSelectedHash(commit.hash)
      }

      const openRewind = (mode) => {
        if (!detail || detail.kind !== 'checkpoint') return
        const deleted = sessionsById.get(detail.sessionId)?.deleted === true
        if (mode === 'files') {
          // Files-only restore works by turn and does not need the live
          // session, so it also covers deleted sessions.
          openRewindDialog({ sessionId, seq: detail.seq ?? null, turn: detail.turn ?? null, mode, inputActions })
          return
        }
        if (deleted || detail.seq === null || detail.seq === undefined) return
        openRewindDialog({ sessionId, seq: detail.seq, mode, inputActions })
      }

      const renderStatus = () => {
        if (!data) return null
        if (source === 'repo') {
          if (!data.isRepo) return h('span', { className: 'dgr-pill' }, t('panel.status.noRepo'))
          return h(Fragment, null,
            h('span', { className: 'dgr-pill' }, translate(t, 'panel.status.repo', {
              branch: data.branch ?? 'detached',
              ahead: data.ahead ?? 0,
              behind: data.behind ?? 0,
              dirty: data.dirty ?? 0,
            })),
            data.dirty > 0 ? h('span', { className: 'dgr-pill' }, '●') : null,
          )
        }
        return h(Fragment, null,
          h('span', { className: 'dgr-pill' }, translate(t, 'panel.status.checkpoints', {
            sessions: data.sessions?.length ?? 0,
            commits: data.commits?.length ?? 0,
          })),
          data.skipped?.length ? h('span', { className: 'dgr-pill' }, `${data.skipped.length} ${t('panel.skipped')}`) : null,
        )
      }

      return h('div', {
        className: `dgr-root dgr-panel${wide ? ' dgr-wide' : ' dgr-narrow'}`,
        ref: rootRef,
      },
        h(Styles),
        hiddenTurnsStyle(wire),
        h('div', { className: 'dgr-head' },
          h('div', { className: 'dgr-title' }, t('panel.title')),
          h('div', { className: 'dgr-tabs' },
            h('button', { className: `dgr-tab${source === 'checkpoints' ? ' dgr-active' : ''}`, onClick: () => { setSource('checkpoints'); setQuery('') } }, t('panel.tab.checkpoints')),
            h('button', { className: `dgr-tab${source === 'repo' ? ' dgr-active' : ''}`, onClick: () => { setSource('repo'); setQuery('') } }, t('panel.tab.repo')),
          ),
          h('button', { className: 'dgr-btn', onClick: refresh, title: t('panel.refresh') }, '↻'),
        ),
        h('div', { className: 'dgr-status' }, renderStatus()),
        h('div', { className: 'dgr-toolbar' },
          h('input', {
            className: 'dgr-search',
            value: query,
            placeholder: t('panel.search'),
            onChange: (event) => setQuery(event.target.value),
          }),
          source === 'checkpoints' ? h('button', {
            className: 'dgr-btn',
            onClick: () => setScope(scope === 'session' ? 'workspace' : 'session'),
            title: scope === 'session' ? t('panel.scope.workspace') : t('panel.scope.session'),
          }, scope === 'session' ? t('panel.scope.session') : t('panel.scope.workspace')) : null,
        ),
        h('div', { className: 'dgr-body' },
          h('div', { className: 'dgr-graph-pane' },
            loading ? h('div', { className: 'dgr-empty' }, t('panel.loading')) : null,
            error ? h('div', { className: 'dgr-empty dgr-error' }, error) : null,
            !loading && !error && commits.length === 0 ? h('div', { className: 'dgr-empty' }, source === 'repo' ? t('panel.empty.repo') : t('panel.empty.checkpoints')) : null,
            !loading && !error && commits.length === 0 && query ? h('div', { className: 'dgr-empty' }, t('panel.empty.search')) : null,
            !loading && !error ? rows.map((row) => {
              const commit = row.commit
              const session = sessionsById.get(commit.sessionId)
              const selected = commit.hash === selectedHash
              return h('div', {
                key: commit.hash,
                className: `dgr-row${selected ? ' dgr-selected' : ''}`,
                onClick: () => { if (!commit.skipped) selectCommit(commit) },
                title: commit.subject,
              },
                h('div', { className: 'dgr-graph', style: { width: laneCount * LANE_W } }, h(GraphSvg, { row, laneCount })),
                h('div', { className: 'dgr-row-body' },
                  h('div', { className: 'dgr-row-title' },
                    session ? h('span', { className: 'dgr-session-dot', style: { background: PALETTE[(session.color ?? 0) % PALETTE.length] } }) : null,
                    h('span', { className: 'dgr-subject' }, commit.subject || commit.shortHash),
                    commit.current ? h('span', { className: 'dgr-badge dgr-badge-current' }, t('panel.current')) : null,
                    commit.skipped ? h('span', { className: 'dgr-badge dgr-badge-skip' }, t('panel.skipped')) : null,
                    session?.deleted ? h('span', { className: 'dgr-badge dgr-badge-skip' }, t('panel.deleted')) : null,
                    session?.parentSession ? h('span', { className: 'dgr-badge dgr-badge-repo', title: `${t('panel.fork')}: ${session.parentSession}` }, t('panel.fork')) : null,
                    (commit.decorations ?? []).map((decoration) => h('span', { className: 'dgr-badge dgr-badge-repo', key: decoration }, decoration)),
                  ),
                  h('div', { className: 'dgr-meta' },
                    h('span', { className: 'dgr-hash' }, commit.shortHash ?? String(commit.hash).slice(0, 8)),
                    commit.turn !== undefined && commit.turn !== null ? h('span', null, `第 ${commit.turn} 轮`) : null,
                    h('span', null, relativeTime(commit.time)),
                    commit.stats ? h('span', null, `${commit.stats.files ?? 0} files · +${commit.stats.additions ?? 0} −${commit.stats.deletions ?? 0}`) : null,
                  ),
                ),
              )
            }) : null,
          ),
          wide && detail ? h(DetailPane, {
            detail, t, diffPath, diff, diffLoading,
            onSelectFile: setDiffPath,
            onRewind: () => openRewind('both'),
            onFilesOnly: () => openRewind('files'),
            sessionDeleted: sessionsById.get(detail.sessionId)?.deleted === true,
          }) : null,
        ),
        !wide && detail ? h(DetailPane, {
          detail, t, diffPath, diff, diffLoading,
          onSelectFile: setDiffPath,
          onRewind: () => openRewind('both'),
          onFilesOnly: () => openRewind('files'),
          sessionDeleted: sessionsById.get(detail.sessionId)?.deleted === true,
        }) : null,
      )
    }

    function DetailPane({ detail, t, diffPath, diff, diffLoading, onSelectFile, onRewind, onFilesOnly, sessionDeleted }) {
      const files = detail.files ?? []
      return h('div', { className: 'dgr-detail' },
        h('div', { className: 'dgr-detail-title' },
          h('span', { className: 'dgr-hash' }, detail.shortHash ?? String(detail.hash).slice(0, 8)),
          detail.kind === 'checkpoint' ? h('span', { className: 'dgr-badge' }, `第 ${detail.turn} 轮`) : null,
        ),
        h('div', { className: 'dgr-detail-meta' },
          detail.subject ?? '',
          h('br'),
          detail.time ? new Date(detail.time).toLocaleString() : '',
          detail.author ? ` · ${detail.author}` : '',
          detail.parents?.length ? h(Fragment, null, h('br'), `${t('panel.detail.parent')}: ${detail.parents.map((hash) => String(hash).slice(0, 8)).join(', ')}`) : null,
        ),
        detail.kind === 'checkpoint' ? h('div', { className: 'dgr-detail-actions' },
          h('button', { className: 'dgr-btn dgr-primary', onClick: onRewind, disabled: sessionDeleted || detail.seq === null || detail.seq === undefined }, t('panel.action.rewind')),
          h('button', { className: 'dgr-btn', onClick: onFilesOnly, disabled: detail.turn === null || detail.turn === undefined }, t('panel.action.files')),
        ) : h('div', { className: 'dgr-detail-actions' },
          h('button', { className: 'dgr-btn', onClick: () => copyText(detail.hash) }, t('panel.action.copy')),
        ),
        h('div', { className: 'dgr-detail-meta' }, t('panel.detail.files')),
        files.length === 0 ? h('div', { className: 'dgr-note' }, t('panel.detail.noFiles')) : null,
        h('div', { className: 'dgr-files' }, files.slice(0, 80).map((file) =>
          h('div', { className: 'dgr-file', key: `${file.status}:${file.path}`, onClick: () => onSelectFile(file.path) },
            h('span', { className: `dgr-hash ${fileStatusClass(file.status)}` }, fileStatusLabel(file.status)),
            h('span', { className: 'dgr-file-path', title: file.path }, file.path),
            h('span', { className: 'dgr-hash' }, file.binary ? 'bin' : `+${file.additions ?? 0} −${file.deletions ?? 0}`),
          ))),
        diffLoading ? h('div', { className: 'dgr-note' }, t('panel.diff.loading')) : null,
        diff ? h('pre', { className: 'dgr-diff' }, diff.text || t('panel.diff.empty')) : null,
      )
    }

    // ---------------------------------------------------------------------
    // Plugin body
    // ---------------------------------------------------------------------
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        const offZh = ctx.locale.register(NS, 'zh', ZH)
        const offEn = ctx.locale.register(NS, 'en', EN)
        return () => { offZh(); offEn() }
      }, 'dsh-git-rewind: dictionaries')

      const deps = { slots: ctx.slots, t }

      /* The built-in user row calls its injected `renderSlotChain` while
         rendering. A child-less wrapper entry is not given one, so supply a
         no-op chain binding exactly like the shipped `steering` registration
         does. NEVER re-declare `children: { 'conversation.chat.user.before': ... }`
         here: the built-in user row already declares that chain child, and a
         second declaration throws `slot "conversation.chat.user.before" is
         already declared` while the client bundle loads, crashing the renderer
         (Desktop renderer exited: crashed). */
      ctx.effect(() => ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: 'user',
        priority: -1,
        locale: 'chat',
        inject: () => ({ renderSlotChain: () => null }),
      }, makeMessageActionView(deps))), 'dsh-git-rewind: user message action')

      const tabs = ctx.sidebarRightTabs
      const right = ctx.sidebarRight
      if (tabs && right) {
        ctx.effect(() => tabs.register({
          id: 'dsh-git-rewind',
          kind: 'git-rewind',
          title: () => t('panel.title'),
          keepMounted: true,
          guide: [{ id: 'git-rewind', title: () => t('panel.title'), icon: PanelIcon, order: 40 }],
        }), 'dsh-git-rewind: sidebar tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: 'dsh-git-rewind',
        }, (props) => h(Panel, { ...props, t }))), 'dsh-git-rewind: sidebar body')
      }

      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'dsh-git-rewind',
        order: 30,
        label: () => t('panel.title'),
      }, () => h(FooterButton, { right, t }))), 'dsh-git-rewind: footer entry')

      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-git-rewind-dialog',
        order: 900,
      }, () => h(RewindDialogHost, { t }))), 'dsh-git-rewind: recall dialog')
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply,
      __test: { layoutGraph, graphWidth },
    }
  },
})
