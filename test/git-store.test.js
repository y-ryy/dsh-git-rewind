import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runProcess } from '../src/exec.js'
import { GitStore, safeRelPath } from '../src/git-store.js'

async function tempDir(name) {
  return mkdtemp(join(tmpdir(), `dgr-${name}-`))
}

test('safeRelPath refuses traversal and absolute paths', () => {
  assert.equal(safeRelPath('src/a.ts'), 'src/a.ts')
  assert.throws(() => safeRelPath('../secret'), /unsafe|refused/)
  assert.throws(() => safeRelPath('C:/secret'), /absolute|refused/)
  assert.throws(() => safeRelPath('/etc/passwd'), /absolute|refused/)
})

test('capture, preview and restore a file checkpoint', async (context) => {
  const workspace = await tempDir('ws')
  const storage = await tempDir('store')
  try {
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'a.txt'), 'one\n', 'utf8')
    await writeFile(join(workspace, 'src', 'b.txt'), 'two\n', 'utf8')
    await mkdir(join(workspace, 'node_modules'))
    await writeFile(join(workspace, 'node_modules', 'ignored.txt'), 'kept\n', 'utf8')

    const store = new GitStore({
      storageDir: storage,
      gitPath: 'git',
      snapshotTimeoutMs: 60000,
      exclude: [],
    }, {})
    const captured = await store.captureTurn({ sessionId: 's1', cwd: workspace, turn: 1, seq: 1, label: 'first' })
    assert.ok(captured.commit)
    assert.equal(captured.parent, null)

    await writeFile(join(workspace, 'a.txt'), 'one changed\n', 'utf8')
    await rm(join(workspace, 'src', 'b.txt'))
    await writeFile(join(workspace, 'added.txt'), 'new\n', 'utf8')
    await writeFile(join(workspace, 'node_modules', 'ignored.txt'), 'changed but excluded\n', 'utf8')

    const preview = await store.preview('s1', workspace, 1)
    assert.equal(preview.checkpoint.turn, 1)
    assert.equal(preview.coverage, 'full')
    const byPath = new Map(preview.files.map((file) => [file.path, file.status]))
    assert.equal(byPath.get('a.txt'), 'M')
    assert.equal(byPath.get('src/b.txt'), 'D')
    assert.equal(byPath.get('added.txt'), 'A')
    assert.equal(byPath.has('node_modules/ignored.txt'), false)

    const restored = await store.restore('s1', workspace, 1)
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'one\n')
    assert.equal(await readFile(join(workspace, 'src', 'b.txt'), 'utf8'), 'two\n')
    await assert.rejects(stat(join(workspace, 'added.txt')))
    assert.equal(await readFile(join(workspace, 'node_modules', 'ignored.txt'), 'utf8'), 'changed but excluded\n')
    assert.ok(restored.rescueId)
    assert.equal(restored.quarantined.includes('added.txt'), true)

    const manifest = JSON.parse(await readFile(join(storage, 'quarantine', 's1', (await (async () => {
      const { readdir } = await import('node:fs/promises')
      return (await readdir(join(storage, 'quarantine', 's1')))[0]
    })()), 'manifest.json'), 'utf8'))
    assert.equal(manifest.files.some((file) => file.path === 'added.txt'), true)

    const after = await store.preview('s1', workspace, 1)
    assert.equal(after.files.length, 0)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(storage, { recursive: true, force: true })
  }
})

test('a checkpoint chain keeps a parent link per session', async () => {
  const workspace = await tempDir('chain-ws')
  const storage = await tempDir('chain-store')
  try {
    await writeFile(join(workspace, 'a.txt'), 'one\n', 'utf8')
    const store = new GitStore({ storageDir: storage, gitPath: 'git', snapshotTimeoutMs: 60000, exclude: [] }, {})
    const first = await store.captureTurn({ sessionId: 's', cwd: workspace, turn: 1, seq: 1, label: 'one' })
    await writeFile(join(workspace, 'a.txt'), 'two\n', 'utf8')
    const second = await store.captureTurn({ sessionId: 's', cwd: workspace, turn: 2, seq: 2, label: 'two' })
    assert.equal(second.parent, first.commit)
    const index = await store.readIndex('s')
    assert.equal(index.checkpoints.length, 2)
    assert.equal(index.checkpoints[1].preview, 'two')
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(storage, { recursive: true, force: true })
  }
})

test('a workspace that is already a Git repository keeps its own index and HEAD', async () => {
  const workspace = await tempDir('user-repo')
  const storage = await tempDir('user-repo-store')
  const git = async (...args) => {
    const result = await runProcess(['git', '-C', workspace, ...args], { cwd: workspace, timeoutMs: 30000 })
    assert.equal(result.exitCode, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    await git('init', '-q')
    await git('config', 'user.name', 'Test')
    await git('config', 'user.email', 'test@example.com')
    await writeFile(join(workspace, 'a.txt'), 'one\n', 'utf8')
    await git('add', 'a.txt')
    await git('commit', '-q', '-m', 'first')
    const beforeHead = await git('rev-parse', 'HEAD')
    const beforeStatus = await git('status', '--porcelain=v1')
    const store = new GitStore({ storageDir: storage, gitPath: 'git', snapshotTimeoutMs: 60000, exclude: [] }, {})
    await store.captureTurn({ sessionId: 'user', cwd: workspace, turn: 1, seq: 1, label: 'one' })
    assert.equal(await git('rev-parse', 'HEAD'), beforeHead)
    assert.equal(await git('status', '--porcelain=v1'), beforeStatus)
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(storage, { recursive: true, force: true })
  }
})
