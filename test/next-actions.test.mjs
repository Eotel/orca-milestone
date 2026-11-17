import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNextSender, nextOffer } from '../src/next-actions.mjs'
import { buildModel } from '../src/model.mjs'
import { renderBody } from '../src/render.mjs'
import { task } from './helpers.mjs'

const steps = [task(1, 'PR を作る', 'pending')]
const agent = (extra = {}) => ({
  agentType: 'claude',
  state: 'done',
  paneKey: 'tab:leaf',
  hasLivePty: true,
  stateStartedAt: 5,
  ...extra
})
const worktree = (agents, extra = {}) => ({ path: '/work/app', agents, ...extra })

test('nextOffer comes from the one live main agent that finished its turn', () => {
  const offer = nextOffer(worktree([agent()]), null, steps)
  assert.equal(offer.path, '/work/app')
  assert.equal(offer.agent, 'claude')
  assert.equal(offer.paneKey, 'tab:leaf')
  assert.equal(offer.suggestions.length, 1)
  assert.notEqual(offer.id, nextOffer(worktree([agent({ stateStartedAt: 6 })]), null, steps).id, 'another turn, another offer')
  assert.notEqual(offer.id, nextOffer(worktree([agent()]), null, [task(1, 'テストを書く', 'pending')]).id, 'other steps, another offer')
  const none = (wt) => assert.equal(nextOffer(wt, null, steps), null)
  none(worktree([agent({ state: 'working' })]))
  assert.equal(nextOffer(worktree([agent()]), null, [task(1, 'PR を作る', 'completed')]), null, 'no step left')
  none(worktree([agent(), agent({ paneKey: 'tab:other' })]))
  none(worktree([agent({ agentType: 'gemini' })]))
  none(worktree([agent()], { isArchived: true }))
  // A closed pane's record and a teammate do not count as a second agent.
  assert.ok(nextOffer(worktree([agent(), agent({ paneKey: 'old', hasLivePty: undefined }), agent({ paneKey: 'mate', parentPaneKey: 'tab:leaf' })]), null, steps))
})

function setupSender({ agentType = 'claude', screen = '? for shortcuts', accepted = true, terminals } = {}) {
  const offer = nextOffer(worktree([agent({ agentType })]), null, steps)
  const calls = []
  const send = createNextSender({
    readOffers: async () => [offer],
    run: async (args) => {
      calls.push(args)
      if (args[1] === 'list') return { result: { terminals: terminals ?? [{ handle: 'h1', tabId: 'tab', leafId: 'leaf', writable: true }] } }
      if (args[1] === 'read') return { result: { terminal: { tail: [screen] } } }
      return { result: { send: { accepted } } }
    },
    wait: async () => {}
  })
  const sent = () => calls.filter((args) => args[1] === 'send').map((args) => args[args.indexOf('--text') + 1])
  return { offer, send, sent }
}

test('a press sends the step read again from the task list, after stashing a Claude draft', async () => {
  const context = setupSender()
  assert.deepEqual(await context.send({ offer: context.offer.id, index: 0 }), { sent: true })
  assert.deepEqual(context.sent(), ['\u0013', '「PR を作る」を進めてください'])
})

test('a second press, an old button and a missing terminal send nothing', async () => {
  const context = setupSender()
  await context.send({ offer: context.offer.id, index: 0 })
  assert.deepEqual(await context.send({ offer: context.offer.id, index: 0 }), { sent: false, reason: 'stale' })
  assert.deepEqual(await context.send({ offer: 'old', index: 0 }), { sent: false, reason: 'stale' })
  assert.deepEqual(await context.send({ offer: context.offer.id, index: 5 }), { sent: false, reason: 'stale' })
  assert.deepEqual(await context.send({ offer: 3, index: '0' }), { sent: false, reason: 'stale' })
  const closed = setupSender({ terminals: [{ handle: 'h1', tabId: 'tab', leafId: 'leaf', writable: false }] })
  assert.deepEqual(await closed.send({ offer: closed.offer.id, index: 0 }), { sent: false, reason: 'stale' })
  assert.equal(context.sent().length, 2)
})

test('Codex is sent nothing while its input box holds a draft, and gets no stash key', async () => {
  const typing = setupSender({ agentType: 'codex', screen: '› half a thought' })
  assert.deepEqual(await typing.send({ offer: typing.offer.id, index: 0 }), { sent: false, reason: 'typing' })
  assert.deepEqual(typing.sent(), [])
  const empty = setupSender({ agentType: 'codex' })
  assert.deepEqual(await empty.send({ offer: empty.offer.id, index: 0 }), { sent: true })
  assert.deepEqual(empty.sent(), ['「PR を作る」を進めてください'])
})

test('a refused send throws and the button can be pressed again', async () => {
  const context = setupSender({ accepted: false })
  await assert.rejects(context.send({ offer: context.offer.id, index: 0 }))
  await assert.rejects(context.send({ offer: context.offer.id, index: 0 }), 'not marked as used')
})

test('the focused workspace shows its offer as cards, escaped, under its tasks', () => {
  const offer = nextOffer(worktree([agent()]), null, [task(1, '<b>直す</b>', 'pending')])
  const sessions = [{ listId: 'l', cwd: '/work/app', goal: 'g', updatedAt: 1, tasks: [{ subject: 't', status: 'completed' }] }]
  const html = renderBody(buildModel({ path: '/work/app', displayName: 'app', agentStates: ['done'] }, sessions, [], [offer]))
  assert.ok(html.includes(`data-next="${offer.id}" data-index="0"`))
  assert.ok(html.includes('&lt;b&gt;直す&lt;/b&gt;'))
  assert.ok(html.indexOf('class="next proposal"') > html.indexOf('<ol><li class="completed">'), 'under the tasks')
  const elsewhere = renderBody(buildModel({ path: '/work/other', displayName: 'other', agentStates: [] }, [], [], [offer]))
  assert.ok(!elsewhere.includes('data-next'), 'only the focused workspace')
  const noTasks = renderBody(buildModel({ path: '/work/app', displayName: 'app', agentStates: ['done'] }, [], [], [offer]))
  assert.ok(noTasks.includes('data-next'), 'also without tasks')
})
