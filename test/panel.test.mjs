import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { sendOnPress } from '../panel/next.mjs'
import { openOnPress } from '../panel/open.mjs'
import { patchChildren } from '../panel/patch.mjs'
import { harness, workspace, at, flush } from './core-fixture.mjs'

const panelDir = join(import.meta.dirname, '..', 'panel')

function body(html = '') {
  const { document } = new JSDOM('<!doctype html><body></body>').window
  document.body.innerHTML = html
  return document.body
}

test('patchChildren keeps the elements that stay and updates what differs', () => {
  const root = body('<main class="a"><p>old</p></main><div class="others"><ol><li>one</li></ol></div>')
  const [main, others] = root.children
  const list = others.querySelector('ol')
  const item = list.querySelector('li')

  patchChildren(root, '<main class="b"><p>new</p></main><div class="others"><ol><li>uno</li><li>two</li></ol></div>')

  assert.equal(root.children[0], main, 'the element is the same one')
  assert.equal(main.className, 'b')
  assert.equal(main.textContent, 'new')
  assert.equal(root.querySelector('ol'), list)
  assert.equal(list.children[0], item)
  assert.equal(item.textContent, 'uno')
  assert.equal(list.children[1].textContent, 'two')
})

test('patchChildren replaces other tags, drops extras and removes old attributes', () => {
  const root = body('<p id="x" class="y">text</p><span>a</span><span>b</span>')
  patchChildren(root, '<div class="y">text</div><span>a</span>')
  assert.equal(root.innerHTML, '<div class="y">text</div><span>a</span>')

  patchChildren(root, '<div>text</div>')
  assert.equal(root.innerHTML, '<div>text</div>')
})

test('patchChildren replaces an element whose data-key differs, and keeps one whose key is the same', () => {
  const root = body('<section data-key="a"><p>0 / 2</p></section>')
  const section = root.children[0]

  patchChildren(root, '<section data-key="a"><p>1 / 2</p></section>')
  assert.equal(root.children[0], section)
  assert.equal(section.textContent, '1 / 2')

  patchChildren(root, '<section data-key="b"><p>0 / 5</p></section>')
  assert.notEqual(root.children[0], section)
  assert.equal(root.children[0].textContent, '0 / 5')
})

test('patchChildren ends with exactly the wanted markup, from an empty panel too', () => {
  const root = body()
  const html = '<main><header><h1>app</h1></header></main><div class="others"><h2>x</h2></div>'
  patchChildren(root, html)
  assert.equal(root.innerHTML, html)
})

test('the panel document loads its stylesheet and script', async () => {
  const html = await readFile(join(panelDir, 'index.html'), 'utf8')
  assert.ok(html.includes('href="style.css"'))
  assert.ok(html.includes('src="main.mjs"'))
  await readFile(join(panelDir, 'style.css'), 'utf8')
  await readFile(join(panelDir, 'main.mjs'), 'utf8')
})

test('pressing a row head opens its workspace, also after a patch, but its detail does not', () => {
  const row = (path) =>
    `<li class="row"><div class="head" role="button" tabindex="0" data-open="${path}"><span class="name">app</span></div><div class="detail"><p>goal</p></div></li>`
  const root = body(`<ol>${row('/work/a')}</ol>`)
  const opened = []
  openOnPress(root, (path) => opened.push(path))
  const { MouseEvent, KeyboardEvent } = root.ownerDocument.defaultView
  const click = (selector) => root.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true }))

  click('.name')
  assert.deepEqual(opened, ['/work/a'])

  click('.detail p')
  assert.equal(opened.length, 1)

  patchChildren(root, `<ol>${row('/work/b')}</ol>`)
  click('.head')
  assert.equal(opened.at(-1), '/work/b')

  const press = (key) => root.querySelector('.head').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  press('Enter')
  press(' ')
  press('a')
  assert.equal(opened.length, 4)
})

test('a pressed card is sent once, and a refusal says why and lets the cards be pressed again', async () => {
  const { sendOnPress } = await import('../panel/next.mjs')
  const root = body('<main><div class="next"><ol class="actions"><li><button data-next="o1" data-path="/work/app" data-index="0">A</button></li><li><button data-next="o1" data-path="/work/app" data-index="1">B</button></li></ol></div></main>')
  const requests = []
  let answer = { sent: false, reason: 'typing' }
  sendOnPress(root, async (request) => {
    requests.push(request)
    return answer
  })
  const [a, b] = root.querySelectorAll('[data-next]')
  b.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(requests, [{ path: '/work/app', offer: 'o1', index: 1 }])
  assert.match(root.querySelector('.status').textContent, /未送信のテキスト/)
  assert.ok(!root.querySelector('.next').classList.contains('busy'))

  answer = { sent: true }
  a.click()
  a.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(requests.length, 2, 'a second click while one is on its way is ignored')
  assert.ok(a.classList.contains('sending'))
  assert.ok(root.querySelector('.next').classList.contains('busy'))
  assert.match(root.querySelector('.status').textContent, /送信しました/, 'a successful retry replaces the previous refusal')
})

test('a press on the focused card says it is sending, and a board that answers too late is not called a failure', async (t) => {
  const next = { id: 'o1', agent: 'claude', suggestions: [{ prompt: '「PR を merge する」を進めてください' }] }
  const h = harness(t, { workspaces: [workspace('app', { agents: [{ agent: 'claude', state: 'done', since: at }], next })] })
  await h.worker.start()
  let answer
  h.state.postGate = new Promise((resolve) => { answer = resolve })
  h.state.postError = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  const root = body(h.html())
  const presses = sendOnPress(root, h.worker.sendNext, { settleMs: 0 })
  root.querySelector('.proposal [data-next]').click()
  await flush()
  patchChildren(root, h.html())
  presses.restore()
  assert.match(root.querySelector('.proposal .status').textContent, /送信中/)
  answer()
  await flush()
  const status = root.querySelector('.proposal .status').textContent
  assert.doesNotMatch(status, /失敗/)
  assert.match(status, /結果を確認できません/)
})

test('a request Orca stopped waiting for is not called a failure, and is not sent again since it may have arrived', async () => {
  const card = '<div class="next"><button data-next="o1" data-path="/work/app" data-index="0">A</button></div>'
  const root = body(card)
  let sends = 0
  const presses = sendOnPress(root, async () => { sends++; throw Object.assign(new Error('next.send timed out after 30000ms'), { code: 'timeout' }) }, { settleMs: 0 })
  root.querySelector('[data-next]').click()
  await flush()
  assert.match(root.querySelector('.status').textContent, /結果を確認できません/)
  root.querySelector('[data-next]').click()
  await flush()
  assert.equal(sends, 1)
  assert.ok(root.querySelector('.next').classList.contains('busy'))
  root.innerHTML = '<p class="unavailable">ボードに接続できません</p>'
  presses.restore()
  root.innerHTML = card
  presses.restore()
  root.querySelector('[data-next]').click()
  await flush()
  assert.equal(sends, 1, 'the board coming back with the same offer does not let it be sent again')
})

test('the panel waits for a send as long as Orca allows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const { window } = new JSDOM('<!doctype html><body><div class="next"><button data-next="o1" data-path="/work/app" data-index="0">A</button></div></body>')
  const requests = []
  window.orca = { plugin: { on: () => {}, request: async (name, input, options) => {
    requests.push([name, options])
    return name === 'view.get' ? { html: window.document.body.innerHTML } : { sent: true }
  } } }
  Object.assign(globalThis, { window, document: window.document })
  t.after(() => { delete globalThis.window; delete globalThis.document })
  await import('../panel/main.mjs')
  window.document.querySelector('[data-next]').click()
  await flush()
  assert.deepEqual(requests.find(([name]) => name === 'next.send')[1], { timeoutMs: 120_000 })
})

test('a card that just came in the place of the answered one takes no presses for a moment', async () => {
  const { sendOnPress } = await import('../panel/next.mjs')
  const { patchChildren } = await import('../panel/patch.mjs')
  const cards = (offer) => `<main><div class="next" data-key="next\n${offer}"><ol class="actions"><li><button data-next="${offer}" data-path="/work/app" data-index="0">テストを書く</button></li><li><button data-next="${offer}" data-path="/work/app" data-index="1">PR を作る</button></li></ol></div></main>`
  const root = body('')
  let time = 0
  const timers = []
  const requests = []
  const presses = sendOnPress(root, async (request) => {
    requests.push(request)
    return { sent: true }
  }, { now: () => time, settleMs: 1500, later: (run) => timers.push(run) })
  const show = (offer) => {
    patchChildren(root, cards(offer))
    presses.restore()
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  show('first')
  assert.ok(root.querySelector('.next').classList.contains('settling'))
  root.querySelector('[data-next]').click()
  await flush()
  assert.deepEqual(requests, [], 'a card is not pressed before it can be read')

  time = 1500
  timers.splice(0).forEach((run) => run())
  assert.ok(!root.querySelector('.next').classList.contains('settling'))
  root.querySelector('[data-next]').click()
  await flush()
  assert.deepEqual(requests, [{ path: '/work/app', offer: 'first', index: 0 }])

  time = 2000
  show('second')
  assert.ok(root.querySelector('.next').classList.contains('settling'), 'the mark survives the patch')
  root.querySelector('[data-next]').click()
  await flush()
  assert.equal(requests.length, 1, 'a quick second click does not answer the next one')

  time = 2400
  show('second')
  assert.ok(root.querySelector('.next').classList.contains('settling'), 'another patch does not restart or lose the wait')
  time = 3500
  timers.splice(0).forEach((run) => run())
  root.querySelectorAll('[data-next]')[1].click()
  await flush()
  assert.deepEqual(requests[1], { path: '/work/app', offer: 'second', index: 1 })
})

test('the board button opens the board once and reports a failure beside the button', async () => {
  const root = body('<footer><button type="button" data-board>ボードを開く</button><p class="status" role="status"></p></footer>')
  let opens = 0
  openOnPress(root, () => assert.fail('no workspace row was pressed'), async () => { opens += 1; return { opened: false } })
  root.querySelector('[data-board]').click()
  root.querySelector('[data-board]').click()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(opens, 1)
  assert.match(root.querySelector('.status').textContent, /ボードを開けませんでした/)
  assert.equal(root.querySelector('[data-board]').disabled, false)
})
