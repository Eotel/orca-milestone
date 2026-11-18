import { join } from 'node:path'
import { createLaunchHook } from './src/launch-hook.mjs'
import { createMilestoneWorker } from './src/milestone-worker.mjs'
import { resolveOrcaCli } from './src/orca-cli.mjs'

export default async function activate(orca) {
  const { settings } = await orca.host.call('settings.get')
  const worker = createMilestoneWorker({ orca, url: settings.boardUrl, cli: resolveOrcaCli() })
  orca.hooks.on(
    'agent.launch.before',
    createLaunchHook({ execPath: process.execPath, serverPath: join(import.meta.dirname, 'src', 'progress-server.mjs') })
  )
  orca.panels.handle('view.get', worker.view)
  orca.panels.handle('workspace.open', ({ path }) => worker.openWorkspace(path))
  orca.panels.handle('next.send', worker.sendNext)
  orca.panels.handle('ask.answer', worker.answerAsk)
  orca.panels.handle('board.open', worker.openBoard)
  orca.commands.register('milestone.refresh', async () => {
    await worker.refresh()
    return 'Milestones refreshed'
  })
  orca.commands.register('milestone.openTurn', worker.openTurn)
  orca.events.on('agent.status.changed', worker.agentChanged)
  orca.events.on('workspace.changed', worker.workspaceChanged)
  await worker.start()
}
