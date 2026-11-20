import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { harness, workspace } from './core-fixture.mjs'

const documentOf = (h) => new JSDOM(h.html()).window.document

test('start reads both core resources and renders the focused path, posting only changed HTML', async (t) => {
  const h = harness(t)
  await h.worker.start()
  assert.deepEqual(h.requests.filter(([url]) => !url.endsWith('/events')).map(([url]) => url), [
    'http://board.test/api/v1/workspaces', 'http://board.test/api/v1/turn'
  ])
  const doc = documentOf(h)
  assert.equal(doc.querySelector('h1').textContent, 'app')
  assert.equal(doc.querySelector('.agent').textContent, 'Claude 作業中')
  assert.match(doc.querySelector('.steps-card').textContent, /1 \/ 3/)
  assert.equal(doc.querySelector('.goal').textContent, 'Core goal')
  assert.equal(doc.querySelectorAll('.steps li').length, 2)
  assert.equal(doc.querySelectorAll('.turn .turn-row').length, 1)
  assert.ok(!doc.querySelector('.steps-card').textContent.includes('Read spec'))
  await h.worker.refresh()
  assert.equal(h.posts.length, 1)
  h.state.workspaces = [workspace('app', { steps: { source: 'none', goal: null, done: 0, total: 0, items: [] } })]
  await h.worker.refresh()
  assert.equal(h.posts.length, 2)
  assert.equal(documentOf(h).querySelector('.steps-card'), null)
})

test('turn count updates the status bar, opens the oldest reachable item, hides on zero and reports an outage', async (t) => {
  const h = harness(t, { items: [
    { ...workspace(), title: 'Remote oldest', path: null, opened_at: '2026-11-17T12:00:00+09:00' },
    { ...workspace(), title: 'Local next', opened_at: '2026-11-18T10:00:00+09:00' }
  ] })
  await h.worker.start()
  assert.deepEqual(h.status(), { id: 'turn', text: 'Owner の番 2', tone: 'warning', tooltip: 'app\nRemote oldest', visible: true })
  assert.deepEqual(await h.worker.openTurn(), { opened: true })
  assert.deepEqual(h.calls.at(-1), ['workspace.open', { workspaceId: 'identity:app' }])
  h.state.items = []
  await h.worker.refresh()
  assert.deepEqual(h.status(), { id: 'turn', visible: false })
  assert.deepEqual(await h.worker.openTurn(), { opened: false })
  h.state.offline = true
  await h.worker.refresh()
  assert.match(h.html(), /ボードに接続できません.*http:\/\/board.test/)
  assert.ok(documentOf(h).querySelector('[data-board]'), 'the board entry remains available during an outage')
  assert.deepEqual(h.status(), { id: 'turn', text: 'ボード未接続', tone: 'danger', tooltip: 'ボードに接続できません http://board.test', visible: true })
  h.state.offline = false
  await h.worker.refresh()
  assert.match(h.html(), /Core goal/)
})

test('changed SSE, all agent events, focused workspace events and the 30 second fallback debounce refreshes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const h = harness(t)
  await h.worker.start()
  const reads = () => h.requests.filter(([url]) => url.endsWith('/turn')).length
  h.changed()
  h.worker.agentChanged({ paneKey: 'p', state: 'working' })
  h.worker.agentChanged({ paneKey: 'p', state: 'working' })
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(149)
  assert.equal(reads(), 1)
  t.mock.timers.tick(1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reads(), 2)
  h.state.workspaces.push(workspace('other', { agents: [{ agent: 'codex', state: 'blocked' }] }))
  h.state.hostRows.push({ id: 'identity:other', name: 'other', path: '/work/other', hostId: 'local' })
  h.worker.workspaceChanged({ context: { workspaceId: 'identity:other', displayName: 'wrong name' } })
  t.mock.timers.tick(150)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(documentOf(h).querySelector('h1').textContent, 'other')
  assert.equal(documentOf(h).querySelector('.agent').textContent, 'Codex 入力待ち')
  h.worker.agentChanged({ paneKey: 'p', state: 'working' })
  t.mock.timers.tick(150)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reads(), 4, 'even a repeated state event reads core')
  t.mock.timers.tick(30000)
  t.mock.timers.tick(150)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reads(), 5)
  h.worker.workspaceChanged({ context: null })
  t.mock.timers.tick(150)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(documentOf(h).querySelector('h1'), null)
})

test('a refresh in flight coalesces further requests into one later refresh', async (t) => {
  const h = harness(t)
  await h.worker.start()
  let release
  h.state.readGate = new Promise((resolve) => { release = resolve })
  const first = h.worker.refresh()
  await new Promise((resolve) => setImmediate(resolve))
  const reads = () => h.requests.filter(([url]) => url.endsWith('/turn')).length
  const second = h.worker.refresh()
  const third = h.worker.refresh()
  assert.equal(reads(), 2)
  release()
  await Promise.all([first, second, third])
  assert.equal(reads(), 3)
})

test('asks precede steps newest first, preserve questions and recommended labels, and escape core text', async (t) => {
  const { ask } = await import('./core-fixture.mjs')
  const h = harness(t, { workspaces: [workspace('app', { asks: [
    ask({ id: 'ask:old', opened_at: '2026-11-16T10:00:00+09:00', questions: [], text: '<script>free text</script>', waits_on: 'triage' }),
    ask({ title: 'Newer', questions: [ask().questions[0], { ...ask().questions[0], question: '表示場所は？' }] })
  ] })] })
  await h.worker.start()
  const doc = documentOf(h)
  const cards = [...doc.querySelectorAll('[data-ask]')]
  assert.deepEqual(cards.map((card) => card.dataset.ask), ['ask:a', 'ask:old'])
  assert.deepEqual(cards.map((card) => [card.classList.contains('ask-card'), card.querySelector('h2 span').textContent]),
    [[true, 'ask'], [false, 'triage への ask']], 'only an ask in the turn list is marked as the owner\'s')
  assert.equal(cards[0].querySelector('time').textContent, new Date(ask().opened_at).toTimeString().slice(0, 5))
  assert.equal(cards[1].querySelector('time').textContent, '11/16')
  assert.equal(cards[0].querySelectorAll('.question').length, 2)
  assert.equal(cards[0].querySelectorAll('.recommended').length, 2)
  assert.match(cards[0].textContent, /すぐに公開/)
  assert.ok(cards[0].querySelector('[data-submit]').disabled)
  assert.ok(cards[1].querySelector('textarea'))
  assert.equal(cards[1].querySelector('script'), null)
  assert.match(cards[1].textContent, /<script>free text<\/script>/)
  assert.ok(h.html().indexOf('ask-card') < h.html().indexOf('steps-card'))
})

test('turn rows show elapsed ages and openable paths; other rows use core counts and done offers first', async (t) => {
  const { turnItem } = await import('./core-fixture.mjs')
  const briefSteps = { source: 'brief', goal: null, done: 0, total: 3, items: [] }
  const h = harness(t, { items: [
    turnItem({ path: null, workspace: 'remote', opened_at: '2026-11-16T12:00:00+09:00' }),
    turnItem({ workspace: 'busy', path: '/work/busy', opened_at: '2026-11-18T10:00:00+09:00' }),
    turnItem({ opened_at: '2026-11-18T11:48:00+09:00' })
  ], workspaces: [
    workspace(), workspace('busy'), workspace('empty', { agents: [], steps: { source: 'none', done: 0, total: 0, items: [] } }),
    workspace('ready', { agents: [{ agent: 'codex', state: 'done' }], next: { id: 'offer:r', agent: 'codex', suggestions: [{ label: '送る', prompt: 'Core prompt' }] } }),
    workspace('steps-only', { agents: [] }),
    workspace('brief-only', { agents: [], steps: briefSteps }),
    workspace('active-brief', { steps: briefSteps }),
    workspace('finished', { agents: [], steps: { source: 'tasks', goal: null, done: 5, total: 5, items: [] } }),
    workspace('agent-only', { steps: { source: 'none', goal: null, done: 0, total: 0, items: [] } }),
    workspace('pair', { agents: [{ agent: 'claude', state: 'done' }, { agent: 'claude', state: 'done' }] }),
    workspace('asking', { agents: [{ agent: 'claude', state: 'waiting' }], steps: { source: 'none', goal: null, done: 0, total: 0, items: [] } })
  ] })
  await h.worker.start()
  const doc = documentOf(h)
  assert.deepEqual([...doc.querySelectorAll('.turn .age')].map((node) => node.textContent), ['2日経過', '2時間経過', '12分経過'])
  assert.equal(doc.querySelector('.turn h2 span:last-child').textContent, '3')
  assert.equal(doc.querySelectorAll('.turn [data-open]').length, 2)
  assert.equal(doc.querySelector('.turn h2 span').textContent, 'Owner の番')
  assert.equal(doc.querySelector('.turn .title').textContent, 'Review the design')
  assert.deepEqual([...doc.querySelectorAll('.others .name')].map((node) => node.textContent), ['asking', 'ready', 'busy', 'steps-only', 'active-brief', 'pair'])
  assert.equal(doc.querySelector('.others [data-key="/work/pair"] .row-agent').textContent, 'Claude 待機中 ×2')
  const ready = doc.querySelector('.others [data-key="/work/ready"]')
  assert.match(ready.textContent, /Codex 待機中.*step 1 \/ 3.*Core prompt.*Codex に送信/s)
  assert.equal(ready.querySelector('[data-next]').dataset.path, '/work/ready')
  assert.equal(ready.querySelector('[data-next]').dataset.index, '0')
  assert.equal(doc.querySelector('[data-board]').textContent, 'ボードを開く')
})

test('next and ask submits go through core, preserving refusal reasons and refreshing after revision conflict', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const h = harness(t)
  await h.worker.start()
  for (const [reason, status] of [['stale', 200], ['typing', 200], ['failed', 502]]) {
    h.state.postResult = { sent: false, reason }
    h.state.postStatus = status
    assert.deepEqual(await h.worker.sendNext({ path: '/work/app', offer: 'abc', index: 0 }), { sent: false, reason })
  }
  h.state.postResult = { error: 'revision changed' }
  h.state.postStatus = 409
  assert.deepEqual(await h.worker.answerAsk({ id: 'ask:a', revision: 3, answers: [{ question: 0, label: '今週' }], text: '' }), { sent: false, reason: 'changed', message: 'revision changed' })
  const before = h.requests.length
  t.mock.timers.tick(150)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.requests.length, before + 2)
  h.state.postError = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  assert.equal((await h.worker.answerAsk({ id: 'ask:a', revision: 4, answers: [], text: '公開します' })).reason, 'timeout')
  h.state.postError = null
  h.state.postResult = { output: 'sent' }
  h.state.postStatus = 200
  assert.deepEqual(await h.worker.answerAsk({ id: 'ask:a', revision: 4, answers: [], text: '公開します' }), { sent: true })
  assert.deepEqual(JSON.parse(h.requests.at(-1)[1].body), { revision: 4, answers: [], text: '公開します' })
})

test('board opens in the configured workspace and switches its matching browser tab', async (t) => {
  const cliCalls = []
  const h = harness(t, { settings: { boardWorkspace: 'control' }, hostRows: [
    { id: 'identity:app', name: 'app', path: '/work/app', hostId: 'local' },
    { id: 'identity:control', name: 'control', path: '/work/control', hostId: 'local' }
  ], runCli: async (cli, args) => {
    cliCalls.push([cli, args])
    if (args[1] === 'list') return { ok: true, result: { tabs: [
      { browserPageId: 'wrong', url: 'http://other.test' },
      { browserPageId: 'board-page', url: 'http://board.test/commitments' }
    ] } }
    return { ok: true, result: { switched: 1, browserPageId: 'board-page' } }
  } })
  await h.worker.start()
  assert.deepEqual(await h.worker.openBoard(), { opened: true })
  assert.deepEqual(h.calls.filter(([method]) => method === 'workspace.open'), [['workspace.open', { workspaceId: 'identity:control' }]])
  assert.deepEqual(cliCalls, [
    ['bundled-orca', ['tab', 'list', '--worktree', 'path:/work/control', '--json']],
    ['bundled-orca', ['tab', 'switch', '--page', 'board-page', '--worktree', 'path:/work/control', '--focus', '--json']]
  ])
})

test('board defaults to triage-lead, creates a tab when absent, and falls back to the focused workspace', async (t) => {
  const cliCalls = []
  const h = harness(t, { runCli: async (_cli, args) => {
    cliCalls.push(args)
    return { ok: true, result: args[1] === 'list' ? { tabs: [] } : { browserPageId: 'created' } }
  } })
  await h.worker.start()
  assert.deepEqual(await h.worker.openBoard(), { opened: true })
  assert.deepEqual(cliCalls.at(-1), ['tab', 'create', '--url', 'http://board.test', '--worktree', 'path:/work/app', '--json'])
  h.state.hostRows.push({ id: 'identity:lead', name: 'triage-lead', path: '/work/triage-lead', hostId: null })
  await h.worker.openBoard()
  assert.deepEqual(h.calls.filter(([method]) => method === 'workspace.open').at(-1), ['workspace.open', { workspaceId: 'identity:lead' }])
  h.state.runCli = null
  h.worker.workspaceChanged({ context: null })
  h.state.hostRows = []
  assert.deepEqual(await h.worker.openBoard(), { opened: false })
})

test('a failed tab command is reported without claiming the board opened', async (t) => {
  const h = harness(t, { runCli: async () => ({ ok: false, error: { message: 'CLI unavailable' } }) })
  await h.worker.start()
  assert.deepEqual(await h.worker.openBoard(), { opened: false })
})

test('turn navigation opens a listed workspace on its host and a missing path sends no open call', async (t) => {
  const h = harness(t, { items: [{ id: 'ask:remote', workspace: 'remote', path: '/remote/app', title: 'Review', opened_at: '2026-11-17T12:00:00+09:00' }],
    hostRows: [{ id: 'remote:app', name: 'app', path: '/remote/app', hostId: 'ssh:remote' }]
  })
  await h.worker.start()
  assert.deepEqual(await h.worker.openTurn(), { opened: true })
  assert.deepEqual(h.calls.at(-1), ['workspace.open', { workspaceId: 'remote:app' }])
  assert.deepEqual(await h.worker.openWorkspace('/missing'), { opened: false })
})

test('one failed GET waits for the other GET before allowing a further refresh', async (t) => {
  const h = harness(t)
  await h.worker.start()
  let release
  h.state.turnGate = new Promise((resolve) => { release = resolve })
  h.state.failWorkspaces = true
  const one = h.worker.refresh()
  await new Promise((resolve) => setImmediate(resolve))
  const two = h.worker.refresh()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.requests.filter(([url]) => url.endsWith('/workspaces')).length, 2)
  release()
  await Promise.all([one, two])
  assert.equal(h.status().text, 'ボード未接続')
})

test('values from the core cannot add markup to the panel', async (t) => {
  const hostile = '"><img src=x onerror=alert(1)>'
  const h = harness(t, { workspaces: [
    workspace('app', {
      agents: [{ agent: 'claude', state: hostile }],
      steps: { source: 'tasks', goal: 'Goal', done: hostile, total: hostile, items: [{ text: 'Step', status: hostile }] },
      asks: [{ id: 'ask:x', revision: hostile, title: 'T', text: 'T', opened_at: '2026-11-18T11:30:00+09:00', waits_on: 'Owner', can_answer: true, questions: [] }]
    }),
    workspace('other', { steps: { source: 'tasks', goal: 'Goal', done: hostile, total: 3, items: [] } })
  ] })
  await h.worker.start()
  assert.equal(documentOf(h).querySelector('img'), null)
})

test('the focused cards show what a press sends and no form for an ask the core refuses', async (t) => {
  const { turnItem } = await import('./core-fixture.mjs')
  const h = harness(t, { items: [turnItem({ id: 'ask:m' })], workspaces: [workspace('app', {
    agents: [{ agent: 'claude', state: 'done' }],
    asks: [{ id: 'ask:m', revision: 1, title: 'Pick', text: 'Pick', opened_at: '2026-11-18T11:30:00+09:00', waits_on: 'Owner', can_answer: false,
      questions: [{ question: 'Pick several', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }] }],
    next: { id: 'offer:a', agent: 'claude', suggestions: [{ label: 'Step', prompt: '「Step」を進めてください' }] }
  })] })
  await h.worker.start()
  const doc = documentOf(h)
  assert.equal(doc.querySelector('.ask-card .ask-text').textContent, 'Pick several')
  assert.equal(doc.querySelector('.ask-card button, .ask-card textarea'), null)
  assert.deepEqual([...doc.querySelectorAll('.proposal .suggestion')].map((node) => [node.querySelector('p').textContent, node.querySelector('button').textContent]),
    [['「Step」を進めてください', 'Claude に送信']])
})
