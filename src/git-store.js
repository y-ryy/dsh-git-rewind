/**
 * The Git-backed checkpoint store.
 *
 * Every workspace gets one private repository under the DSH home. Checkpoints
 * are ordinary commits on a per-session ref, so they can be inspected with any
 * Git tool; the user's own repository is never opened as GIT_DIR.
 */
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, link, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DEFAULT_EXCLUDES } from './constants.js'
import { runProcess } from './exec.js'

export class GitStoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'GitStoreError'
    this.code = code
    this.details = details
  }
}

/** Validate one repository-relative POSIX path. */
export function safeRelPath(path) {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) {
    throw new GitStoreError('path-rejected', 'empty or invalid path')
  }
  const normalized = path.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new GitStoreError('path-rejected', `absolute path refused: ${path}`)
  }
  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new GitStoreError('path-rejected', `unsafe path refused: ${path}`)
  }
  return parts.join('/')
}

function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Move a file across volumes: rename first, then copy+unlink on EXDEV. */
async function moveFile(from, to) {
  try {
    await rename(from, to)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

function parseNumstat(text) {
  const lines = text.split('\n').filter(Boolean)
  let additions = 0
  let deletions = 0
  let files = 0
  for (const line of lines) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    files += 1
    const add = Number.parseInt(parts[0], 10)
    const del = Number.parseInt(parts[1], 10)
    if (Number.isFinite(add)) additions += add
    if (Number.isFinite(del)) deletions += del
  }
  return { files, additions, deletions }
}

function parseNameStatusZ(text) {
  const tokens = text.split('\0')
  const files = []
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index]
    if (!status) continue
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = tokens[index + 1] ?? ''
      const newPath = tokens[index + 2] ?? ''
      index += 2
      if (newPath) files.push({ status: 'R', path: newPath, oldPath })
    } else {
      const path = tokens[index + 1] ?? ''
      index += 1
      if (path) files.push({ status: status[0], path })
    }
  }
  return files
}

export class GitStore {
  constructor(config, ctx) {
    this.config = config
    this.ctx = ctx
    this.root = config.storageDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'dsh-git-rewind')
    this.gitPath = config.gitPath || 'git'
    this.excludes = [...DEFAULT_EXCLUDES, ...(Array.isArray(config.exclude) ? config.exclude : [])]
    this.timeoutMs = config.snapshotTimeoutMs || 15000
    this.repos = new Map()
    this.locks = new Map()
  }

  repoKey(cwd) {
    return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)
  }

  repoDir(cwd) {
    return join(this.root, 'repos', this.repoKey(cwd))
  }

  sessionsDir() {
    return join(this.root, 'sessions')
  }

  indexFile(sessionId) {
    return join(this.sessionsDir(), `${sessionId}.json`)
  }

  async ensureRepo(cwd) {
    const key = this.repoKey(cwd)
    const existing = this.repos.get(key)
    if (existing) return existing
    const promise = (async () => {
      const repoDir = this.repoDir(cwd)
      const gitDir = join(repoDir, '.git')
      await mkdir(repoDir, { recursive: true })
      let hasGit = true
      try {
        await stat(gitDir)
      } catch {
        hasGit = false
      }
      if (!hasGit) {
        const init = await runProcess([this.gitPath, 'init', '--quiet', repoDir], {
          cwd: repoDir,
          timeoutMs: 30000,
          maxBytes: 1024 * 1024,
        })
        if (init.exitCode !== 0) {
          throw new GitStoreError('git-unavailable', `git init failed: ${init.stderr || init.stdout}`)
        }
      }
      const git = (args) => runProcess([this.gitPath, `--git-dir=${gitDir}`, `--work-tree=${cwd}`, ...args], {
        cwd,
        timeoutMs: 30000,
        maxBytes: 2 * 1024 * 1024,
        env: { GIT_TERMINAL_PROMPT: '0' },
      })
      for (const [keyName, value] of [
        ['core.worktree', cwd],
        ['core.bare', 'false'],
        ['core.autocrlf', 'false'],
        ['core.fileMode', 'false'],
        ['gc.auto', '0'],
        ['user.name', 'DSH Rewind'],
        ['user.email', 'rewind@dsh.local'],
      ]) {
        const result = await git(['config', keyName, value])
        if (result.exitCode !== 0) throw new GitStoreError('git-failed', `git config ${keyName} failed`)
      }
      const infoDir = join(gitDir, 'info')
      await mkdir(infoDir, { recursive: true })
      await writeFile(join(infoDir, 'exclude'), `${this.excludes.join('\n')}\n`, 'utf8')
      return { repoDir, gitDir, cwd }
    })()
    this.repos.set(key, promise)
    try {
      return await promise
    } catch (error) {
      this.repos.delete(key)
      throw error
    }
  }

  async git(cwd, args, options = {}) {
    const repo = await this.ensureRepo(cwd)
    return runProcess([this.gitPath, `--git-dir=${repo.gitDir}`, `--work-tree=${cwd}`, ...args], {
      cwd,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
      env: {
        GIT_TERMINAL_PROMPT: '0',
        ...(options.env ?? {}),
      },
      signal: options.signal,
    })
  }

  async gitText(cwd, args, options = {}) {
    const result = await this.git(cwd, args, options)
    if (result.exitCode !== 0) {
      throw new GitStoreError('git-failed', `${args[0]} failed: ${result.stderr || result.stdout}`.trim())
    }
    return result.stdout.trim()
  }

  async withRepoLock(cwd, operation) {
    const key = this.repoKey(cwd)
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release
    const current = new Promise((resolveLock) => { release = resolveLock })
    const queued = previous.then(() => current)
    this.locks.set(key, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(key) === queued) this.locks.delete(key)
    }
  }

  async revParse(cwd, ref) {
    const result = await this.git(cwd, ['rev-parse', '--verify', '--quiet', ref], { maxBytes: 64 * 1024 })
    if (result.exitCode !== 0) return null
    const value = result.stdout.trim()
    return value === '' ? null : value
  }

  async refreshTree(cwd) {
    const add = await this.git(cwd, ['add', '-A', '--', '.'], { maxBytes: 2 * 1024 * 1024 })
    if (add.exitCode !== 0) {
      throw new GitStoreError('git-failed', `git add failed: ${add.stderr || add.stdout}`.trim())
    }
    return this.gitText(cwd, ['write-tree'], { maxBytes: 64 * 1024 })
  }

  async diffStats(cwd, parent, commit) {
    const args = parent
      ? ['diff-tree', '--numstat', '-r', '--no-commit-id', parent, commit]
      : ['diff-tree', '--root', '--numstat', '-r', '--no-commit-id', commit]
    const result = await this.git(cwd, args, { maxBytes: 2 * 1024 * 1024 })
    if (result.exitCode !== 0) return { files: 0, additions: 0, deletions: 0 }
    return parseNumstat(result.stdout)
  }

  async readIndex(sessionId) {
    try {
      const text = await readFile(this.indexFile(sessionId), 'utf8')
      const parsed = JSON.parse(text)
      return {
        version: 1,
        sessionId,
        workspace: parsed.workspace ?? '',
        label: parsed.label ?? '',
        parentSession: parsed.parentSession ?? null,
        checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { version: 1, sessionId, workspace: '', label: '', parentSession: null, checkpoints: [] }
      }
      if (error instanceof SyntaxError) {
        throw new GitStoreError('index-corrupt', `checkpoint index is not valid JSON: ${sessionId}`)
      }
      throw error
    }
  }

  async writeIndex(index) {
    await mkdir(this.sessionsDir(), { recursive: true })
    const file = this.indexFile(index.sessionId)
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  }

  async listIndexes() {
    let entries = []
    try {
      entries = await readdir(this.sessionsDir(), { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const indexes = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const sessionId = entry.name.slice(0, -5)
      try {
        indexes.push(await this.readIndex(sessionId))
      } catch {
        // A corrupt index must not hide every other session's graph.
      }
    }
    return indexes
  }

  async captureTurn({ sessionId, cwd, turn, seq, label, parentSession }) {
    return this.withRepoLock(cwd, async () => {
      const index = await this.readIndex(sessionId)
      if (index.workspace !== '' && resolve(index.workspace) !== resolve(cwd)) {
        throw new GitStoreError('workspace-changed', 'the checkpoint index belongs to a different workspace')
      }
      if (index.parentSession === null && parentSession) index.parentSession = parentSession
      const tree = await this.refreshTree(cwd)
      const ref = `refs/dsh-git-rewind/${sessionId}`
      const parent = await this.revParse(cwd, ref)
      const message = `checkpoint session=${sessionId} turn=${turn} at=${new Date().toISOString()}`
      const commit = await this.gitText(cwd, [
        'commit-tree',
        tree,
        ...(parent ? ['-p', parent] : []),
        '-m',
        message,
      ], {
        env: {
          GIT_AUTHOR_NAME: 'DSH Rewind',
          GIT_AUTHOR_EMAIL: 'rewind@dsh.local',
          GIT_COMMITTER_NAME: 'DSH Rewind',
          GIT_COMMITTER_EMAIL: 'rewind@dsh.local',
        },
      })
      const updateArgs = parent
        ? ['update-ref', ref, commit, parent]
        : ['update-ref', ref, commit]
      await this.gitText(cwd, updateArgs)
      const stats = await this.diffStats(cwd, parent, commit)
      if (index.workspace === '') index.workspace = cwd
      if (label && index.label === '') index.label = label
      index.checkpoints.push({
        kind: 'turn',
        turn,
        seq: seq ?? null,
        commit,
        parent,
        tree,
        time: Date.now(),
        preview: label || '',
        stats,
      })
      await this.writeIndex(index)
      return { commit, parent, tree, stats }
    })
  }

  async captureRescue(sessionId, cwd) {
    return this.withRepoLock(cwd, async () => {
      const tree = await this.refreshTree(cwd)
      const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`
      const message = `rescue session=${sessionId} at=${new Date().toISOString()}`
      const commit = await this.gitText(cwd, ['commit-tree', tree, '-m', message], {
        env: {
          GIT_AUTHOR_NAME: 'DSH Rewind',
          GIT_AUTHOR_EMAIL: 'rewind@dsh.local',
          GIT_COMMITTER_NAME: 'DSH Rewind',
          GIT_COMMITTER_EMAIL: 'rewind@dsh.local',
        },
      })
      await this.gitText(cwd, ['update-ref', `refs/dsh-git-rewind-rescue/${sessionId}/${stamp}`, commit])
      return { commit, tree, time: Date.now(), stamp }
    })
  }

  async preview(sessionId, cwd, turn) {
    const index = await this.readIndex(sessionId)
    if (index.workspace !== '' && resolve(index.workspace) !== resolve(cwd)) {
      throw new GitStoreError('workspace-changed', 'the checkpoint index belongs to a different workspace')
    }
    const checkpoint = index.checkpoints.find((item) => item.kind === 'turn' && item.turn === turn)
    if (!checkpoint) {
      return {
        checkpoint: null,
        files: [],
        summary: { changed: 0, added: 0, deleted: 0, additions: 0, deletions: 0 },
        coverage: 'none',
        warnings: [],
      }
    }
    return this.withRepoLock(cwd, async () => {
      const currentTree = await this.refreshTree(cwd)
      const names = await this.git(cwd, [
        'diff-tree', '-r', '-z', '--name-status', '--no-commit-id', checkpoint.tree, currentTree,
      ], { maxBytes: 4 * 1024 * 1024 })
      const nums = await this.git(cwd, [
        'diff-tree', '-r', '-z', '--numstat', '--no-commit-id', checkpoint.tree, currentTree,
      ], { maxBytes: 4 * 1024 * 1024 })
      const entries = names.exitCode === 0 ? parseNameStatusZ(names.stdout) : []
      const statsByPath = new Map()
      if (nums.exitCode === 0) {
        for (const record of nums.stdout.split('\0')) {
          if (!record) continue
          const firstTab = record.indexOf('\t')
          const secondTab = record.indexOf('\t', firstTab + 1)
          if (firstTab === -1 || secondTab === -1) continue
          const add = record.slice(0, firstTab)
          const del = record.slice(firstTab + 1, secondTab)
          const path = record.slice(secondTab + 1)
          statsByPath.set(path, {
            additions: add === '-' ? null : Number.parseInt(add, 10),
            deletions: del === '-' ? null : Number.parseInt(del, 10),
            binary: add === '-' || del === '-',
          })
        }
      }
      const files = entries.map((entry) => ({
        ...entry,
        ...(statsByPath.get(entry.path) ?? { additions: 0, deletions: 0, binary: false }),
      }))
      const summary = {
        changed: files.filter((file) => file.status === 'M' || file.status === 'T').length,
        added: files.filter((file) => file.status === 'A').length,
        deleted: files.filter((file) => file.status === 'D').length,
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
      }
      return {
        checkpoint: {
          turn: checkpoint.turn,
          seq: checkpoint.seq,
          commit: checkpoint.commit,
          parent: checkpoint.parent,
          time: checkpoint.time,
        },
        files,
        summary,
        coverage: index.workspace === '' || resolve(index.workspace) === resolve(cwd) ? 'full' : 'none',
        warnings: [],
      }
    })
  }

  async restore(sessionId, cwd, turn, signal) {
    const index = await this.readIndex(sessionId)
    if (index.workspace !== '' && resolve(index.workspace) !== resolve(cwd)) {
      throw new GitStoreError('workspace-changed', 'the checkpoint index belongs to a different workspace')
    }
    const checkpoint = index.checkpoints.find((item) => item.kind === 'turn' && item.turn === turn)
    if (!checkpoint) throw new GitStoreError('no-checkpoint', `turn ${turn} has no file checkpoint`)
    const preview = await this.preview(sessionId, cwd, turn)
    if (preview.files.length === 0) {
      return { restored: 0, quarantined: [], rescueId: null, warnings: [] }
    }
    const rescue = await this.captureRescue(sessionId, cwd)
    const quarantineDir = join(this.root, 'quarantine', sessionId, `${Date.now()}-${randomUUID().slice(0, 8)}`)
    const manifest = []
    const quarantined = []
    const restorePaths = []
    const warnings = []
    const moved = []

    try {
      for (const file of preview.files) {
        const relPath = safeRelPath(file.path)
        const absolute = join(cwd, ...relPath.split('/'))
        if (!isInside(cwd, absolute)) {
          throw new GitStoreError('path-rejected', `path escapes the workspace: ${file.path}`)
        }
        let info
        try {
          info = await lstat(absolute)
        } catch {
          info = null
        }
        if (info && info.isSymbolicLink()) {
          warnings.push(`skipped symbolic link: ${relPath}`)
          continue
        }
        if (info && info.isDirectory()) {
          warnings.push(`skipped directory: ${relPath}`)
          continue
        }
        if (file.status === 'A') {
          if (!info) continue
          const target = join(quarantineDir, ...relPath.split('/'))
          await mkdir(dirname(target), { recursive: true })
          await moveFile(absolute, target)
          manifest.push({ path: relPath, status: 'A', bytes: info.size })
          quarantined.push(relPath)
          moved.push({ relPath, target, mode: 'added' })
          continue
        }
        restorePaths.push(relPath)
        if (!info) continue
        const target = join(quarantineDir, ...relPath.split('/'))
        await mkdir(dirname(target), { recursive: true })
        try {
          await link(absolute, target)
        } catch {
          await copyFile(absolute, target)
        }
        manifest.push({ path: relPath, status: file.status, bytes: info.size })
        quarantined.push(relPath)
        moved.push({ relPath, target, mode: 'copy' })
      }

      if (restorePaths.length > 0) {
        const restore = await this.git(cwd, [
          'restore', `--source=${checkpoint.commit}`, '--worktree', '--staged', '--', ...restorePaths,
        ], { maxBytes: 2 * 1024 * 1024, signal, timeoutMs: Math.max(this.timeoutMs, 60000) })
        if (restore.exitCode !== 0) {
          throw new GitStoreError('git-failed', `git restore failed: ${restore.stderr || restore.stdout}`.trim())
        }
      }

      for (const relPath of restorePaths) {
        const absolute = join(cwd, ...relPath.split('/'))
        try {
          const info = await stat(absolute)
          const expected = await this.git(cwd, ['cat-file', '-s', `${checkpoint.commit}:${relPath}`], { maxBytes: 64 * 1024 })
          if (expected.exitCode === 0 && Number.parseInt(expected.stdout.trim(), 10) !== info.size) {
            warnings.push(`size differs after restore: ${relPath}`)
          }
        } catch {
          warnings.push(`missing after restore: ${relPath}`)
        }
      }

      if (manifest.length > 0) {
        await mkdir(quarantineDir, { recursive: true })
        await writeFile(join(quarantineDir, 'manifest.json'), `${JSON.stringify({
          sessionId,
          turn,
          createdAt: new Date().toISOString(),
          files: manifest,
        }, null, 2)}\n`, 'utf8')
      }
      return { restored: restorePaths.length, quarantined, rescueId: rescue.commit, warnings }
    } catch (error) {
      // Return every quarantined byte and restore the pre-rewind tree.
      for (const item of moved) {
        const absolute = join(cwd, ...item.relPath.split('/'))
        try {
          if (item.mode === 'added') {
            await mkdir(dirname(absolute), { recursive: true })
            await moveFile(item.target, absolute)
          }
        } catch { /* best-effort rollback */ }
      }
      try {
        if (restorePaths.length > 0) {
          await this.git(cwd, [
            'restore', `--source=${rescue.commit}`, '--worktree', '--staged', '--', ...restorePaths,
          ], { maxBytes: 2 * 1024 * 1024, timeoutMs: 60000 })
        }
      } catch { /* keep the original failure */ }
      throw error instanceof GitStoreError
        ? error
        : new GitStoreError('git-failed', error instanceof Error ? error.message : String(error))
    }
  }

  async commitFiles(cwd, commit, parent) {
    const names = await this.git(cwd, [
      'diff-tree', '-r', '-z', '--name-status', '--no-commit-id',
      ...(parent ? [parent, commit] : ['--root', commit]),
    ], { maxBytes: 4 * 1024 * 1024 })
    const nums = await this.git(cwd, [
      'diff-tree', '-r', '-z', '--numstat', '--no-commit-id',
      ...(parent ? [parent, commit] : ['--root', commit]),
    ], { maxBytes: 4 * 1024 * 1024 })
    const entries = names.exitCode === 0 ? parseNameStatusZ(names.stdout) : []
    const stats = new Map()
    if (nums.exitCode === 0) {
      for (const record of nums.stdout.split('\0')) {
        if (!record) continue
        const firstTab = record.indexOf('\t')
        const secondTab = record.indexOf('\t', firstTab + 1)
        if (firstTab === -1 || secondTab === -1) continue
        stats.set(record.slice(secondTab + 1), {
          additions: record.slice(0, firstTab) === '-' ? null : Number.parseInt(record.slice(0, firstTab), 10),
          deletions: record.slice(firstTab + 1, secondTab) === '-' ? null : Number.parseInt(record.slice(firstTab + 1, secondTab), 10),
          binary: record.slice(0, firstTab) === '-',
        })
      }
    }
    return entries.map((entry) => ({ ...entry, ...(stats.get(entry.path) ?? {}) }))
  }

  async commitPatch(cwd, commit, path, maxBytes = 262144) {
    const rel = safeRelPath(path)
    const result = await this.git(cwd, [
      'show', '--format=', '--no-color', '--patch', '--unified=3', commit, '--', rel,
    ], { maxBytes })
    return { text: result.stdout, truncated: result.truncated }
  }
}
