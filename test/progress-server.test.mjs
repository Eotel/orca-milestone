import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TOOL_NAME, handleMessage, progressDir } from '../src/progress-server.mjs'

async function context() {
  return { dir: await mkdtemp(join(tmpdir(), 'progress-')), pid: 4242, cwd: '/work/app', now: () => 1000 }
}

const call = (args, id = 2) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: TOOL_NAME, arguments: args } })

test('the server answers the MCP handshake and lists its tool', async () => {
  const ctx = await context()
  const init = handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, ctx)
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.deepEqual(init.result.capabilities, { tools: {} })
  assert.equal(handleMessage({ method: 'notifications/initialized' }, ctx), null)
  const { tools } = handleMessage({ id: 2, method: 'tools/list' }, ctx).result
  assert.deepEqual(tools.map((tool) => tool.name), [TOOL_NAME])
  assert.equal(handleMessage({ id: 3, method: 'nope' }, ctx).error.code, -32601)
})

test('a recorded plan writes the progress file consumed by the core, with no temporary file left', async () => {
  const ctx = await context()
  const tasks = [{ subject: 'Read', status: 'completed' }, { subject: 'Write', status: 'in_progress' }]
  const answer = handleMessage(call({ goal: 'Ship', tasks }), ctx)
  assert.equal(answer.result.isError, false)
  assert.deepEqual(await readdir(ctx.dir), ['codex-4242.json'], 'no temporary file stays')

  const recorded = JSON.parse(await readFile(join(ctx.dir, 'codex-4242.json'), 'utf8'))
  assert.deepEqual(recorded,
    {
      pid: 4242,
      cwd: '/work/app',
      goal: 'Ship',
      updatedAt: 1000,
      tasks: [
        { id: '1', subject: 'Read', status: 'completed' },
        { id: '2', subject: 'Write', status: 'in_progress' }
      ]
    }
  )
})

test('bad arguments are reported to the agent and record nothing', async () => {
  const ctx = await context()
  for (const args of [{}, { goal: '', tasks: [] }, { goal: 'g', tasks: 'x' }, { goal: 'g', tasks: [{ subject: 's', status: 'done' }] }]) {
    assert.equal(handleMessage(call(args), ctx).result.isError, true)
  }
  assert.deepEqual(await readdir(ctx.dir), [])
})

test('long text is clipped before it is stored', async () => {
  const ctx = await context()
  handleMessage(call({ goal: 'g'.repeat(900), tasks: [{ subject: 's'.repeat(900), status: 'pending' }] }), ctx)
  const body = JSON.parse(await readFile(join(ctx.dir, 'codex-4242.json'), 'utf8'))
  assert.equal(body.goal.length, 500)
  assert.equal(body.tasks[0].subject.length, 500)
  assert.equal(progressDir('/home/me'), '/home/me/.orca-milestone/progress')
})
