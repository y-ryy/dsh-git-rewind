import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

async function loadClientTestApi() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let captured
  const React = {
    createElement: () => null,
    Fragment: 'fragment',
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: () => ({ current: null }),
    useState: (value) => [value, () => {}],
    useSyncExternalStore: (_subscribe, get) => get(),
  }
  const context = {
    window: { __ModuleLoader__: { load: (definition) => { captured = definition } } },
    fetch: async () => { throw new Error('not available in unit test') },
    document: { addEventListener: () => {}, removeEventListener: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    ResizeObserver: class { observe() {} disconnect() {} },
    Date,
    console,
  }
  vm.runInNewContext(source, context)
  assert.ok(captured, 'client module registered')
  const plugin = captured.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  return plugin.__test
}

test('layoutGraph places a linear chain in one lane', async () => {
  const { layoutGraph } = await loadClientTestApi()
  const rows = layoutGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ])
  assert.deepEqual(Array.from(rows, (row) => row.lane), [0, 0, 0])
})

test('layoutGraph opens a lane for a merge parent', async () => {
  const { layoutGraph } = await loadClientTestApi()
  const rows = layoutGraph([
    { hash: 'merge', parents: ['left', 'right'] },
    { hash: 'left', parents: ['root'] },
    { hash: 'right', parents: ['root'] },
    { hash: 'root', parents: [] },
  ])
  assert.equal(rows[0].lane, 0)
  assert.ok(rows[0].edges.some((edge) => edge.kind === 'out' && edge.to !== 0))
})

test('layoutGraph handles independent roots (one lane per session)', async () => {
  const { layoutGraph, graphWidth } = await loadClientTestApi()
  const rows = layoutGraph([
    { hash: 's1-b', parents: ['s1-a'] },
    { hash: 's2-a', parents: [] },
    { hash: 's1-a', parents: [] },
  ])
  assert.ok(graphWidth(rows) >= 1)
  assert.equal(rows.length, 3)
})
