import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import activate from '../main.mjs'
import { createLaunchHook, withProgressTool, withTaskInstructions } from '../src/launch-hook.mjs'

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'orca-plugin.json'), 'utf8'))

test('registers manifest commands and events, and starts the core reads for the status bar on activate', async (t) => {
  const commands = []
  const events = []
  const handlers = new Map()
  const hooks = []
  const requested = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(url)
    if (url.endsWith('/events')) return new Response(new ReadableStream({}))
    return Response.json(url.endsWith('/workspaces') ? { workspaces: [], version: 1 } : { items: [], version: 1 })
  })
  const calls = []
  await activate({
    host: { call: async (method, params) => {
      calls.push([method, params])
      if (method === 'workspace.readContext') return null
      if (method === 'workspace.list') return { workspaces: [] }
      if (method === 'settings.get') return { settings: { boardUrl: 'http://board.test:17317' } }
      return { ok: true }
    } },
    events: { on: (event) => events.push(event) },
    commands: { register: (id) => commands.push(id) },
    panels: { handle: (name, handler) => handlers.set(name, handler), post: () => {} },
    hooks: { on: (hook) => hooks.push(hook) },
    log: () => {}
  })
  assert.deepEqual(commands, manifest.contributes.commands.map((command) => command.id))
  assert.deepEqual(events, manifest.contributes.events.map((event) => event.on))
  assert.deepEqual([...handlers.keys()], ['view.get', 'workspace.open', 'next.send', 'ask.answer', 'board.open'])
  assert.deepEqual(hooks, manifest.contributes.hooks.map((hook) => hook.event))
  assert.ok(requested.includes('http://board.test:17317/api/v1/turn'))
  assert.ok(calls.some(([method, params]) => method === 'statusBar.update' && params.visible === false))
  assert.equal(manifest.contributes.statusBarItems[0].command, 'milestone.openTurn')
})

const paths = { execPath: '/Apps/Orca.app/MacOS/Orca', serverPath: '/plugin/src/progress-server.mjs' }

test('a Claude launch gets the task tools turned on, and an unknown agent passes untouched', () => {
  const hook = createLaunchHook(paths)
  const next = (event) => event
  const decided = hook({ agent: 'claude', command: 'claude', env: { KEPT: 'x' } }, next)
  assert.deepEqual(decided.env, { KEPT: 'x', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' })
  assert.ok(decided.command.startsWith("claude --append-system-prompt 'The user follows"))
  assert.ok(decided.command.includes('metadata: {"goal":'))

  assert.equal(hook({ agent: 'gemini', command: 'gemini', env: {} }, () => assert.fail('passes')), undefined)
})

test('an Agent Teams launch gets the same as a Claude launch, through orca claude-teams', () => {
  const hook = createLaunchHook(paths)
  const event = { agent: 'claude-agent-teams', command: 'orca claude-teams --dangerously-skip-permissions', env: {} }
  const { command, env } = hook(event, (decided) => decided)
  assert.deepEqual(env, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' })
  assert.ok(command.startsWith("orca claude-teams --append-system-prompt 'The user follows"))
  assert.ok(command.endsWith(' --dangerously-skip-permissions'))
  assert.equal(command.match(/'/g).length % 2, 0, 'the quotes balance')
})

test('withTaskInstructions accepts each spelling of orca claude-teams and nothing near it', () => {
  for (const launcher of ['orca-ide claude-teams', 'orca-dev claude-teams', '/opt/bin/orca claude-teams']) {
    assert.ok(withTaskInstructions(launcher).startsWith(`${launcher} --append-system-prompt `), launcher)
  }
  for (const untouched of ['orca claude-teamsx', 'orca worktree list', 'orcas claude-teams', "orca claude-teams --append-system-prompt 'mine'"]) {
    assert.equal(withTaskInstructions(untouched), untouched)
  }
})

test('a Codex launch gets the progress tool, keeping the rest of its command line', () => {
  const hook = createLaunchHook(paths)
  const { command, env } = hook({ agent: 'codex', command: "/bin/codex --yolo 'do it'", env: {} }, (event) => event)
  assert.deepEqual(env, {})
  assert.ok(command.startsWith('/bin/codex -c '))
  assert.ok(command.endsWith(" --yolo 'do it'"))
  assert.ok(command.includes(`-c 'mcp_servers.milestone.command="/Apps/Orca.app/MacOS/Orca"'`))
  assert.ok(command.includes(`-c 'mcp_servers.milestone.args=["/plugin/src/progress-server.mjs"]'`))
  assert.ok(command.includes(`-c 'mcp_servers.milestone.env={ELECTRON_RUN_AS_NODE="1"}'`))
  assert.ok(command.includes(`-c 'developer_instructions="Whenever the work takes three or more tool calls, you must first call the update_progress tool`))
  assert.equal(command.match(/'/g).length % 2, 0, 'the quotes balance')
})

test('neither agent is told to end its reply with a block for the panel, and each command stays one line', () => {
  const hook = createLaunchHook(paths)
  for (const agent of ['claude', 'codex']) {
    const { command } = hook({ agent, command: agent, env: {} }, (event) => event)
    assert.ok(!/fenced code block|info string/.test(command), agent)
    assert.ok(!command.includes('\n'), `${agent} is typed into a terminal, where a newline is Enter`)
    assert.equal(command.match(/'/g).length % 2, 0, 'the quotes balance')
  }
})

test('withProgressTool leaves other commands and paths it cannot quote alone', () => {
  assert.equal(withProgressTool('env X=1 codex', paths), 'env X=1 codex')
  assert.equal(withProgressTool('codexish', paths), 'codexish')
  assert.equal(withProgressTool('codex', { ...paths, serverPath: "/it's/server.mjs" }), 'codex')
})

test('withTaskInstructions keeps the command line and leaves existing instructions alone', () => {
  const command = withTaskInstructions("/bin/claude --teammate-mode auto 'do it'")
  assert.ok(command.startsWith('/bin/claude --append-system-prompt '))
  assert.ok(command.endsWith(" --teammate-mode auto 'do it'"))
  assert.equal(command.match(/'/g).length, 4, 'the instructions hold no quote of their own')
  assert.ok(!command.includes('--settings'), 'no permission hook: the panel answers no permission')

  for (const untouched of ['env X=1 claude', 'claudette', "claude --append-system-prompt 'mine'", 'claude --append-system-prompt-file /f']) {
    assert.equal(withTaskInstructions(untouched), untouched)
  }
})
