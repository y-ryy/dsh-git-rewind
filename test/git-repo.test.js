import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runProcess } from '../src/exec.js'
import { isRepo, parseLog, parseStatusV2, repoCommit, repoDiff, repoLog, repoStatus } from '../src/git-repo.js'

async function git(cwd, args) {
  const result = await runProcess(['git', '-C', cwd, ...args], { cwd, timeoutMs: 30000 })
  assert.equal(result.exitCode, 0, result.stderr)
  return result.stdout.trim()
}

test('parseStatusV2 reads branch, ahead/behind and dirty count', () => {
  const parsed = parseStatusV2('# branch.oid abc\x00# branch.head main\x00# branch.ab +2 -1\x001 .M N... 100644 100644 100644 a b file.txt\x00')
  assert.deepEqual(parsed, { branch: 'main', ahead: 2, behind: 1, dirty: 1 })
})

test('parseLog reads NUL-separated commits and decorations', () => {
  const commits = parseLog([
    ['a'.repeat(40), 'b'.repeat(40), 'aaaaaaa', 'Alice', '1700000000', 'HEAD -> main, tag: v1', 'first'].join('\x1f'),
    ['b'.repeat(40), '', 'bbbbbbb', 'Bob', '1690000000', '', 'root'].join('\x1f'),
  ].join('\0'))
  assert.equal(commits.length, 2)
  assert.deepEqual(commits[0].parents, ['b'.repeat(40)])
  assert.deepEqual(commits[0].decorations, ['HEAD -> main', 'tag: v1'])
  assert.equal(commits[1].subject, 'root')
})

test('read-only repository queries work on a real repository', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dgr-repo-'))
  const config = { gitPath: 'git' }
  try {
    await git(cwd, ['init', '-q'])
    await git(cwd, ['config', 'user.name', 'Test'])
    await git(cwd, ['config', 'user.email', 'test@example.com'])
    await writeFile(join(cwd, 'a.txt'), 'one\n', 'utf8')
    await git(cwd, ['add', 'a.txt'])
    await git(cwd, ['commit', '-q', '-m', 'first'])
    await writeFile(join(cwd, 'b.txt'), 'two\n', 'utf8')
    await git(cwd, ['add', 'b.txt'])
    await git(cwd, ['commit', '-q', '-m', 'second'])

    assert.equal(await isRepo(config, cwd), true)
    const status = await repoStatus(config, cwd)
    assert.equal(status.isRepo, true)
    assert.ok(status.branch)
    assert.equal(status.dirty, 0)
    const commits = await repoLog(config, cwd, 10)
    assert.equal(commits.length, 2)
    const head = commits[0]
    const detail = await repoCommit(config, cwd, head.hash)
    assert.equal(detail.subject, 'second')
    assert.equal(detail.files.some((file) => file.path === 'b.txt'), true)
    const diff = await repoDiff(config, cwd, head.hash, 'b.txt')
    assert.match(diff.text, /\+two/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a plain directory is not a repository', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dgr-norepo-'))
  try {
    assert.equal(await isRepo({ gitPath: 'git' }, cwd), false)
    assert.equal((await repoStatus({ gitPath: 'git' }, cwd)).isRepo, false)
    assert.deepEqual(await repoLog({ gitPath: 'git' }, cwd), [])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
