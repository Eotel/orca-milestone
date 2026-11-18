import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { harness, workspace, ask, flush } from './core-fixture.mjs'
import { patchChildren } from '../panel/patch.mjs'
import { sendOnPress } from '../panel/next.mjs'

async function panel(t, asks = [ask()]) {
  const h = harness(t, { workspaces: [workspace('app', { asks })] })
  await h.worker.start()
  const root = new JSDOM('<!doctype html><body></body>').window.document.body
  root.innerHTML = h.html()
  const presses = sendOnPress(root, h.worker.sendNext, { answerAsk: h.worker.answerAsk, settleMs: 0 })
  const option = (q, o) => root.querySelector(`[data-question="${q}"][data-option="${o}"]`)
  const submit = () => root.querySelector('[data-submit]')
  return { h, root, presses, option, submit }
}

test('each question needs one choice; ticks survive patches and submit sends labels and revision once', async (t) => {
  const question = ask().questions[0]
  const p = await panel(t, [ask({ questions: [question, { ...question, question: '表示は？' }] })])
  p.option(0, 0).click()
  p.option(0, 1).click()
  assert.equal(p.option(0, 0).getAttribute('aria-pressed'), 'false')
  assert.equal(p.submit().disabled, true)
  p.option(1, 0).click()
  assert.equal(p.submit().disabled, false)
  const note = p.root.querySelector('textarea[aria-label="補足（任意）"]')
  note.value = '直してから'
  note.dispatchEvent(new p.root.ownerDocument.defaultView.Event('input', { bubbles: true }))
  patchChildren(p.root, p.h.html())
  p.presses.restore()
  assert.equal(p.option(0, 1).getAttribute('aria-pressed'), 'true')
  assert.equal(p.root.querySelector('textarea').value, '直してから')
  p.submit().click()
  p.submit().click()
  await flush()
  const posts = p.h.requests.filter(([, init]) => init.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual(JSON.parse(posts[0][1].body), { revision: 3, answers: [{ question: 0, label: '来週' }, { question: 1, label: '今週' }], text: '直してから' })
  patchChildren(p.root, p.h.html())
  p.presses.restore()
  p.submit().click()
  await flush()
  assert.equal(p.h.requests.filter(([, init]) => init.method === 'POST').length, 1, 'a successful ask stays locked while the same revision is shown')
})

test('a free text reply survives patches and sends the text; whitespace alone cannot submit', async (t) => {
  const p = await panel(t, [ask({ questions: [], text: 'どの方法にしますか？' })])
  const input = () => p.root.querySelector('textarea')
  const type = (text) => {
    input().value = text
    input().dispatchEvent(new p.root.ownerDocument.defaultView.Event('input', { bubbles: true }))
  }
  type('  ')
  assert.equal(p.submit().disabled, true)
  type('こちらで修正します')
  patchChildren(p.root, p.h.html())
  p.presses.restore()
  assert.equal(input().value, 'こちらで修正します')
  assert.equal(p.submit().disabled, false)
  p.submit().click()
  await flush()
  const [, init] = p.h.requests.find(([, init]) => init.method === 'POST')
  assert.deepEqual(JSON.parse(init.body), { revision: 3, answers: [], text: 'こちらで修正します' })
})

test('a 409 explains the changed ask; a new revision clears ticks and settles before it accepts choices', async (t) => {
  const p = await panel(t)
  p.h.state.postResult = { error: 'この commitment には回答を送れません' }
  p.h.state.postStatus = 400
  p.option(0, 0).click()
  p.submit().click()
  await flush()
  assert.equal(p.root.querySelector('.ask-card .status').textContent, '送信に失敗しました。この commitment には回答を送れません')
  p.h.state.postResult = { error: 'changed' }
  p.h.state.postStatus = 409
  p.submit().click()
  await flush()
  assert.match(p.root.querySelector('.ask-card .status').textContent, /ask が変わった/)
  p.h.state.workspaces[0].asks[0].revision = 4
  await p.h.worker.refresh()
  patchChildren(p.root, p.h.html())
  p.presses.restore()
  assert.equal(p.submit().disabled, true)
  assert.equal(p.option(0, 0).getAttribute('aria-pressed'), 'false')
})

test('a newly arrived ask revision and next offer ignore presses for 1.5 seconds', async (t) => {
  const h = harness(t, { workspaces: [workspace('app', { asks: [ask()] })] })
  await h.worker.start()
  const root = new JSDOM('<!doctype html><body></body>').window.document.body
  let time = 0
  const timers = []
  const presses = sendOnPress(root, h.worker.sendNext, { answerAsk: h.worker.answerAsk, now: () => time, later: (run) => timers.push(run) })
  patchChildren(root, h.html())
  presses.restore()
  const option = () => root.querySelector('[data-option]')
  option().click()
  assert.equal(option().getAttribute('aria-pressed'), 'false')
  time = 1500
  timers.splice(0).forEach((run) => run())
  option().click()
  assert.equal(option().getAttribute('aria-pressed'), 'true')
  h.state.workspaces[0].asks[0].revision = 4
  await h.worker.refresh()
  patchChildren(root, h.html())
  presses.restore()
  option().click()
  assert.equal(option().getAttribute('aria-pressed'), 'false')
  time = 3000
  timers.splice(0).forEach((run) => run())
  option().click()
  assert.equal(option().getAttribute('aria-pressed'), 'true')
})
