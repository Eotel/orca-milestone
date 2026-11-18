import { sendOnPress } from './next.mjs'
import { openOnPress } from './open.mjs'
import { patchChildren } from './patch.mjs'

const RETRY_MS = 3000
const KEEP_ALIVE_MS = 60_000

let pushes = 0
const presses = sendOnPress(document.body, (request) => window.orca.plugin.request('next.send', request), {
  answerAsk: (request) => window.orca.plugin.request('ask.answer', request)
})
let loaded = false

const { plugin } = window.orca

plugin.on('view.changed', ({ html }) => {
  pushes += 1
  loaded = true
  patchChildren(document.body, html)
  presses.restore()
})

async function load() {
  const seen = pushes
  try {
    const { html } = await plugin.request('view.get')
    if (pushes === seen) {
      patchChildren(document.body, html)
      presses.restore()
    }
    loaded = true
  } catch (error) {
    console.warn(`milestone: view.get failed: ${error.code ?? error.message}`)
    if (!loaded) setTimeout(load, RETRY_MS)
  }
}

openOnPress(document.body, (path) => {
  plugin.request('workspace.open', { path }).catch((error) => {
    console.warn(`milestone: workspace.open failed: ${error.code ?? error.message}`)
  })
}, () => plugin.request('board.open'))
void load()
setInterval(load, KEEP_ALIVE_MS)
