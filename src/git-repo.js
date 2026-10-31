/**
 * Read-only queries against the user's own Git repository.
 *
 * Nothing here writes: the panel is a viewer. Every command is an argv array,
 * cwd is fixed to the session workspace, and output is bounded.
 */
import { runProcess } from './exec.js'
import { GitStoreError, safeRelPath } from './git-store.js'

const HASH = /^[0-9a-f]{4,64}$/i

function gitArgs(gitPath, cwd, args) {
  return [gitPath, '-C', cwd, ...args]
}

async function runGit(config, cwd, args, options = {}) {
  const result = await runProcess(gitArgs(config.gitPath || 'git', cwd, args), {
    cwd,
    timeoutMs: options.timeoutMs ?? 10000,
    maxBytes: options.maxBytes ?? 2 * 1024 * 1024,
    env: {
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
      ...(options.env ?? {}),
    },
  })
  if (options.allowFailure) return result
  if (result.exitCode !== 0) {
    throw new GitStoreError('git-failed', `${args[0]} failed: ${result.stderr || result.stdout}`.trim())
  }
  return result
}

export async function isRepo(config, cwd) {
  try {
    const result = await runGit(config, cwd, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })
    return result.exitCode === 0 && result.stdout.trim() === 'true'
  } catch {
    return false
  }
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(text) {
  const tokens = text.split('\0')
  let branch = null
  let ahead = 0
  let behind = 0
  let dirty = 0
  for (const token of tokens) {
    if (!token) continue
    if (token.startsWith('# branch.head ')) {
      const value = token.slice('# branch.head '.length)
      branch = value === '(detached)' ? null : value
    } else if (token.startsWith('# branch.ab ')) {
      const match = token.match(/\+(\d+)\s+-(\d+)/)
      if (match) {
        ahead = Number.parseInt(match[1], 10)
        behind = Number.parseInt(match[2], 10)
      }
    } else if (!token.startsWith('#')) {
      dirty += 1
    }
  }
  return { branch, ahead, behind, dirty }
}

export async function repoStatus(config, cwd) {
  if (!(await isRepo(config, cwd))) {
    return { isRepo: false, branch: null, ahead: 0, behind: 0, dirty: 0 }
  }
  const result = await runGit(config, cwd, ['status', '--porcelain=v2', '--branch', '-z'], {
    maxBytes: 4 * 1024 * 1024,
  })
  return { isRepo: true, ...parseStatusV2(result.stdout) }
}

function parseDecorations(raw) {
  if (!raw) return []
  return raw.split(',').map((part) => part.trim()).filter(Boolean)
}

/** Parse one `git log -z` record stream. */
export function parseLog(text) {
  const commits = []
  for (const record of text.split('\0')) {
    if (!record) continue
    const fields = record.split('\x1f')
    if (fields.length < 7) continue
    const [hash, parents, shortHash, author, time, decorations, subject] = fields
    commits.push({
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      shortHash,
      author,
      time: Number.parseInt(time, 10) * 1000,
      decorations: parseDecorations(decorations),
      subject,
    })
  }
  return commits
}

export async function repoLog(config, cwd, limit = 200) {
  if (!(await isRepo(config, cwd))) return []
  const capped = Math.max(1, Math.min(500, Number.isFinite(limit) ? limit : 200))
  const result = await runGit(config, cwd, [
    'log',
    '--all',
    '--date-order',
    `--max-count=${capped}`,
    '--pretty=format:%H%x1f%P%x1f%h%x1f%an%x1f%at%x1f%D%x1f%s',
    '-z',
  ], { maxBytes: 8 * 1024 * 1024, timeoutMs: 15000 })
  return parseLog(result.stdout)
}

function assertHash(hash) {
  if (!HASH.test(String(hash ?? ''))) throw new GitStoreError('bad-request', 'invalid commit hash')
  return String(hash)
}

export async function repoCommit(config, cwd, hash) {
  const safe = assertHash(hash)
  const head = await runGit(config, cwd, [
    'show', '-s', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%B', safe,
  ], { maxBytes: 256 * 1024 })
  const fields = head.stdout.split('\x1f')
  const [fullHash, parents, author, email, seconds, subject, body = ''] = fields
  const names = await runGit(config, cwd, [
    'show', '--format=', '--name-status', '-z', safe,
  ], { maxBytes: 4 * 1024 * 1024 })
  const nums = await runGit(config, cwd, [
    'show', '--format=', '--numstat', '-z', safe,
  ], { maxBytes: 4 * 1024 * 1024 })
  const files = []
  const tokens = names.stdout.split('\0')
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
  const stats = new Map()
  for (const record of nums.stdout.split('\0')) {
    if (!record) continue
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    if (first === -1 || second === -1) continue
    const add = record.slice(0, first)
    const del = record.slice(first + 1, second)
    const path = record.slice(second + 1)
    stats.set(path, {
      additions: add === '-' ? null : Number.parseInt(add, 10),
      deletions: del === '-' ? null : Number.parseInt(del, 10),
      binary: add === '-',
    })
  }
  return {
    hash: fullHash,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    author,
    email,
    time: Number.parseInt(seconds, 10) * 1000,
    subject,
    body,
    files: files.map((file) => ({ ...file, ...(stats.get(file.path) ?? {}) })),
  }
}

export async function repoDiff(config, cwd, hash, path, maxBytes = 262144) {
  const safeHash = assertHash(hash)
  const rel = safeRelPath(path)
  const result = await runGit(config, cwd, [
    'show', '--format=', '--no-color', '--patch', '--unified=3', safeHash, '--', rel,
  ], { maxBytes })
  return { text: result.stdout, truncated: result.truncated }
}
