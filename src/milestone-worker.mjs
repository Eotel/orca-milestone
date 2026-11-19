import { createCoreClient } from './core-client.mjs'
import { buildModel } from './model.mjs'
import { renderBody } from './render.mjs'
import { openBoardTab } from './orca-cli.mjs'

const errorReason = (error) => error.name === 'TimeoutError' ? 'timeout' : 'failed'

export function createMilestoneWorker({ orca, fetch, url, now = Date.now, cli, runCli }) {
  const core = createCoreClient({ fetch, url })
  let focusedId
  let lastHtml
  let started
  let running
  let rerun = false
  let timer
  let sync
  let disconnect
  let turnItems = []
  let turnLabel = ''
  let offline = false

  function publish(html) {
    if (html === lastHtml) return
    lastHtml = html
    orca.panels.post('view.changed', { html })
  }

  async function refreshOnce() {
    if (focusedId === undefined) {
      const context = await orca.host.call('workspace.readContext')
      if (focusedId === undefined) focusedId = context?.workspaceId ?? null
    }
    const results = await Promise.allSettled([
      core.workspaces(), core.turn(), orca.host.call('workspace.list')
    ])
    for (const result of results) if (result.status === 'rejected') throw result.reason
    const [snapshot, turn, { workspaces }] = results.map((result) => result.value)
    const focused = workspaces.find((row) => row.id === focusedId)
    turnItems = turn.items
    turnLabel = turn.label
    offline = false
    publish(renderBody(buildModel(focused, snapshot.workspaces, turn, now())))
    await updateStatus()
  }

  function updateStatus() {
    const oldest = turnItems[0]
    if (offline) return orca.host.call('statusBar.update', { id: 'turn', text: 'ボード未接続', tone: 'danger', tooltip: `ボードに接続できません ${core.url}`, visible: true })
    return orca.host.call('statusBar.update', oldest ? {
      id: 'turn', text: `${turnLabel} ${turnItems.length}`, tone: 'warning',
      tooltip: `${oldest.workspace}\n${oldest.title}`, visible: true
    } : { id: 'turn', visible: false })
  }

  async function refresh() {
    if (running) {
      rerun = true
      return running
    }
    running = (async () => {
      do {
        rerun = false
        try {
          await refreshOnce()
        } catch (error) {
          turnItems = []
          offline = true
          publish(renderBody({ unavailable: true, url: core.url }))
          await updateStatus()
          orca.log(`milestone: refresh failed: ${error.message}`)
        }
      } while (rerun)
    })()
    try { await running } finally { running = null }
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(() => void refresh(), 150)
    timer.unref?.()
  }

  function start() {
    started ??= (async () => {
      disconnect = core.listen(schedule)
      sync = setInterval(schedule, 30_000)
      sync.unref?.()
      await refresh()
    })()
    return started
  }

  function stop() {
    disconnect?.()
    clearTimeout(timer)
    clearInterval(sync)
  }

  async function view() {
    await start()
    return { html: lastHtml }
  }

  async function openWorkspace(path) {
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      const target = workspaces.find((row) => row.path === path)
      if (!target) return { opened: false }
      await orca.host.call('workspace.open', { workspaceId: target.id })
      return { opened: true }
    } catch (error) {
      orca.log(`milestone: could not open workspace: ${error.message}`)
      return { opened: false }
    }
  }

  async function openTurn() {
    await start()
    const oldest = turnItems.find((item) => item.path)
    return oldest ? openWorkspace(oldest.path) : { opened: false }
  }

  function workspaceChanged({ context }) {
    focusedId = context?.workspaceId ?? null
    schedule()
  }

  async function sendNext(request) {
    try {
      const result = await core.sendNext(request)
      schedule()
      return result
    } catch (error) {
      orca.log(`milestone: send failed: ${error.message}`)
      return { sent: false, reason: errorReason(error), message: error.message }
    }
  }

  async function answerAsk(request) {
    try {
      await core.answerAsk(request)
      schedule()
      return { sent: true }
    } catch (error) {
      if (error.status === 409) schedule()
      orca.log(`milestone: answer failed: ${error.message}`)
      return { sent: false, reason: error.status === 409 ? 'changed' : errorReason(error), message: error.message }
    }
  }

  async function openBoard() {
    try {
      await start()
      const [{ settings }, { workspaces }] = await Promise.all([
        orca.host.call('settings.get'), orca.host.call('workspace.list')
      ])
      const target = workspaces.find((row) => row.name === (settings.boardWorkspace ?? 'triage-lead')) ?? workspaces.find((row) => row.id === focusedId)
      if (!target) return { opened: false }
      await orca.host.call('workspace.open', { workspaceId: target.id })
      await openBoardTab(cli, target.path, core.url, runCli)
      return { opened: true }
    } catch (error) {
      orca.log(`milestone: could not open board: ${error.message}`)
      return { opened: false }
    }
  }

  return { start, refresh, schedule, view, stop, openWorkspace, openTurn, workspaceChanged, agentChanged: schedule, sendNext, answerAsk, openBoard }
}
