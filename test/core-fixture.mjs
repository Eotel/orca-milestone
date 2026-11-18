import assert from 'node:assert/strict'
import { createMilestoneWorker } from '../src/milestone-worker.mjs'

export const at = Date.parse('2026-11-18T12:00:00+09:00')
export const workspace = (name = 'app', extra = {}) => ({
  workspace: name, repo: 'repo', path: `/work/${name}`, branch: 'main',
  agents: [{ agent: 'claude', state: 'working', since: at }],
  steps: { source: 'tasks', goal: 'Core goal', done: 1, total: 3, items: [
    { text: 'Read spec', status: 'done' }, { text: 'Write code', status: 'in_progress' }, { text: 'Run tests', status: 'pending' }
  ] },
  asks: [], pulls: [], next: null, ...extra
})
export const ask = (extra = {}) => ({
  id: 'ask:a', revision: 3, title: 'Release', text: 'Release details', opened_at: '2026-11-18T11:30:00+09:00', waits_on: 'Owner',
  questions: [{ question: '公開の時期は？', header: '時期', recommended: '今週', multiSelect: false, options: [
    { label: '今週', description: 'すぐに公開' }, { label: '来週', description: '来週に公開' }
  ] }], ...extra
})
export const turnItem = (extra = {}) => ({
  id: 'ask:a', kind: 'ask', title: 'Review the design', workspace: 'app', repo: 'repo', path: '/work/app', host: 'local',
  opened_at: '2026-11-18T10:00:00+09:00', ...extra
})
export const flush = () => new Promise((resolve) => setImmediate(resolve))

export function harness(t, options = {}) {
  const state = {
    workspaces: [workspace()], items: [turnItem()], offline: false,
    hostRows: [{ id: 'identity:app', name: 'app', path: '/work/app', hostId: 'local' }],
    context: { workspaceId: 'identity:app' }, postResult: { sent: true }, postStatus: 200,
    ...options
  }
  const requests = []
  const calls = []
  const posts = []
  const streams = []
  const fetch = async (url, init = {}) => {
    requests.push([url, init])
    assert.ok(url.startsWith('http://board.test/'), 'never contacts the real board')
    if (state.offline) throw new Error('board offline')
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      streams.push(controller)
      init.signal.addEventListener('abort', () => controller.close(), { once: true })
    } }))
    if (init.method === 'POST') return Response.json(state.postResult, { status: state.postStatus })
    if (url.endsWith('/workspaces') && state.failWorkspaces) throw new Error('workspaces failed')
    if (url.endsWith('/turn') && state.turnGate) await state.turnGate
    if (state.readGate) await state.readGate
    return Response.json(url.endsWith('/workspaces')
      ? { version: 1, generation: 4, workspaces: state.workspaces }
      : { version: 1, generation: 4, label: 'Owner の番', items: state.items })
  }
  const orca = {
    host: { call: async (method, params) => {
      calls.push([method, params])
      if (method === 'workspace.list') return { workspaces: state.hostRows, truncated: false }
      if (method === 'workspace.readContext') return state.context
      if (method === 'settings.get') return { settings: state.settings ?? {} }
      if (method === 'workspace.open') return { opened: true }
      if (method === 'statusBar.update') return { ok: true }
      assert.fail(`unexpected host call ${method}`)
    } },
    panels: { post: (event, body) => posts.push([event, body]) }, log: () => {}
  }
  const worker = createMilestoneWorker({ orca, fetch, url: 'http://board.test', now: () => at, cli: 'bundled-orca', runCli: state.runCli })
  t.after(() => worker.stop())
  return { state, requests, calls, posts, streams, worker, orca,
    html: () => posts.at(-1)[1].html,
    status: () => calls.filter(([method]) => method === 'statusBar.update').at(-1)[1],
    changed: () => streams[0].enqueue(new TextEncoder().encode('event: changed\ndata: {}\n\n'))
  }
}
