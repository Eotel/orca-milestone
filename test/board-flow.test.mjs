import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createLaneSender } from '../src/lane-send.mjs'
import { createMilestoneWorker } from '../src/milestone-worker.mjs'
import { SESSION_A, SESSION_B, makeHome, task, writeTasks, writeTranscript } from './helpers.mjs'

const agent = (extra = {}) => ({ agentType: 'claude', state: 'done', paneKey: 'tab:leaf', hasLivePty: true, stateStartedAt: 7, lastAssistantMessage: 'できました', ...extra })
const steps = [
  task(1, '今の検索 API を調べる', 'completed'),
  task(2, 'テストを書く', 'pending', { blockedBy: ['3'] }),
  task(3, 'フィルターの UI を作る', 'in_progress'),
  task(4, 'PR を作る', 'pending')
]
const terminal = { handle: 'term_lane', tabId: 'tab', leafId: 'leaf', writable: true }

function fakeOrca() {
  const posts = []
  return { log: () => {}, panels: { post: (event, payload) => posts.push({ event, payload }) }, shown: () => posts.at(-1).payload.html }
}

/** A Claude session running in /work/app, as Claude registers it, with these lines in its transcript. */
async function runningSession(home, extra) {
  await writeTranscript(home, SESSION_A, { cwd: '/work/app', prompt: 'Go', running: false, extra })
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true })
  await writeFile(join(home, '.claude', 'sessions', '1.json'), JSON.stringify({ pid: process.pid, sessionId: SESSION_A, cwd: '/work/app' }))
}

function workerFor(home, agents, { sendToLane = async () => {} } = {}) {
  const orca = fakeOrca()
  const keys = []
  const runCli = async (_cli, args) => {
    if (args[0] === 'worktree') return { ok: true, result: { worktrees: [{ path: '/work/app', displayName: 'app', isActive: true, agents }] } }
    if (args[1] === 'list') return { result: { terminals: [terminal] } }
    if (args[1] === 'read') return { result: { terminal: { tail: ['? for shortcuts'] } } }
    keys.push(args[args.indexOf('--text') + 1])
    return { result: { send: { accepted: true } } }
  }
  const worker = createMilestoneWorker({ orca, home, cli: 'orca', runCli, sendToLane, watchDir: () => {} })
  return { orca, worker, keys }
}

test('the panel offers no question, permission or restart cards, only the proposed next steps', async () => {
  const home = await makeHome()
  const question = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: '公開の時期は？', multiSelect: false, options: [{ label: '今週' }, { label: '来週' }] }] } }] } }
  await runningSession(home, [question])
  const asking = workerFor(home, [agent({ state: 'waiting', toolName: 'AskUserQuestion', lastAssistantMessage: '' })])
  await asking.worker.refresh(true)
  assert.ok(!asking.orca.shown().includes('公開の時期は？'))

  const permission = workerFor(home, [agent({ state: 'waiting', toolName: 'Bash', toolInput: 'rm -rf build', lastAssistantMessage: '' })])
  await permission.worker.refresh(true)
  assert.ok(!permission.orca.shown().includes('許可しますか'))

  // This test process was not started with the plugin's instructions, which upstream offers to restart.
  await writeTasks(home, SESSION_A, steps)
  const done = workerFor(home, [agent()])
  await done.worker.refresh(true)
  assert.ok(done.orca.shown().includes('data-next'))
  assert.ok(!done.orca.shown().includes('最新の指示で再開'))
})

test('the next steps are the unfinished tasks of the session, the one in progress first and none still blocked', async () => {
  const home = await makeHome()
  await runningSession(home, [])
  await writeTasks(home, SESSION_A, steps)
  const { orca, worker } = workerFor(home, [agent({ lastAssistantMessage: 'できました\n```next\n[{"label":"別の作業","prompt":"別の作業をして"}]\n```' })])
  await worker.refresh(true)
  const cards = [...orca.shown().matchAll(/class="action"[^>]*><span class="label">([^<]+)</g)].map((match) => match[1])
  assert.deepEqual(cards, ['フィルターの UI を作る', 'PR を作る'])

  // A task file changing asks Orca nothing; the cards follow the tasks all the same.
  await writeTasks(home, SESSION_A, steps.map((step) => ({ ...step, status: 'completed' })))
  await worker.refresh()
  assert.ok(!orca.shown().includes('data-next'), 'nothing left to do, no cards')
})

test('a workspace with the task lists of two running sessions offers no cards, since a press could reach the other one', async () => {
  const home = await makeHome()
  await runningSession(home, [])
  await writeTasks(home, SESSION_A, steps)
  await writeTranscript(home, SESSION_B, { cwd: '/work/app', prompt: 'Go', running: false })
  await writeFile(join(home, '.claude', 'sessions', '2.json'), JSON.stringify({ pid: process.pid, sessionId: SESSION_B, cwd: '/work/app' }))
  await writeTasks(home, SESSION_B, [task(1, '別の作業', 'pending')])
  const { orca, worker } = workerFor(home, [agent()])
  await worker.refresh(true)
  assert.ok(orca.shown().includes('別の作業'), 'the lists still show')
  assert.ok(!orca.shown().includes('data-next'))
})

test('a pressed next step goes to the lane through send, after stashing a Claude draft', async () => {
  const home = await makeHome()
  await runningSession(home, [])
  await writeTasks(home, SESSION_A, steps)
  const lane = []
  const { orca, worker, keys } = workerFor(home, [agent()], { sendToLane: async (handle, prompt) => lane.push([handle, prompt]) })
  await worker.refresh(true)
  const offer = orca.shown().match(/data-next="([0-9a-f]+)"/)[1]
  assert.deepEqual(await worker.sendNext({ offer, index: 0 }), { sent: true })
  assert.deepEqual(lane, [['term_lane', '「フィルターの UI を作る」を進めてください']])
  assert.deepEqual(keys, ['\u0013'])
})

test('createLaneSender runs send from ORCA_BRIEFS_BIN and tells a landed text from a refused one', async () => {
  const home = await makeHome()
  const bin = join(home, 'bin')
  await mkdir(bin)
  const log = join(home, 'args.txt')
  // Exits as send does: 0 landed, 3 landed but the agent hit its limit, 1 FAILED.
  await writeFile(join(bin, 'send'), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > '${log}'\ncase "$2" in term_limited) echo LIMITED; exit 3;; term_gone) echo 'FAILED: 担当は閉じている'; exit 1;; esac\necho 'sent: turn_started'\n`)
  await chmod(join(bin, 'send'), 0o755)
  const send = createLaneSender({ home, env: { ORCA_BRIEFS_BIN: bin, PATH: '/usr/bin:/bin' } })
  await send('term_lane', 'PR を作ってください')
  const [cwd, ...args] = (await readFile(log, 'utf8')).trimEnd().split('\n')
  assert.deepEqual([cwd, args], [await realpath(home), ['--no-keep', 'term_lane', 'PR を作ってください']])
  await send('term_limited', 'x')
  await assert.rejects(send('term_gone', 'x'), /FAILED: 担当は閉じている/)
})
