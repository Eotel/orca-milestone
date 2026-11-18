import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildModel } from '../src/model.mjs'
import { renderBody } from '../src/render.mjs'

const [out, flag] = process.argv.slice(2)
if (!out) {
  console.error('usage: node scripts/render-sample.mjs <out.html> [--next | --light]')
  process.exit(1)
}
const now = Date.parse('2026-11-18T20:43:00+09:00')
const row = (workspace, agents, steps, extra = {}) => ({ workspace, path: `/work/${workspace}`, repo: 'sample', branch: 'main', agents, steps, asks: [], pulls: [], next: null, ...extra })
const agent = (state = 'working') => [{ agent: 'claude', state, since: now }]
const steps = {
  source: 'tasks', goal: '検索の絞り込みを追加する', done: 3, total: 4,
  items: [
    ...Array.from({ length: 3 }, (_, index) => ({ text: `完了した step ${index + 1}`, status: 'done' })),
    { text: '絞り込みの条件を URL に残す', status: 'in_progress' }
  ]
}
const focus = row('search-filters', agent(), steps, { asks: [{
  id: 'ask:sample', revision: 3, title: '絞り込みの初期値', text: '', opened_at: '2026-11-18T20:31:00+09:00', waits_on: 'Owner',
  questions: [
    { question: '絞り込みの初期値をどうしますか？', header: '初期値', recommended: '前回の条件', options: [
      { label: '前回の条件', description: '' }, { label: 'すべて', description: '' }
    ], multiSelect: false }
  ]
}] })
if (flag === '--next') {
  focus.agents = agent('done')
  focus.asks = []
  focus.next = { id: 'sample-next', agent: 'claude', suggestions: [{ label: '条件を URL に残す', prompt: '「絞り込みの条件を URL に残す」を進めてください' }] }
}
const workspaces = [focus,
  row('checkout-retry', agent(), { ...steps, goal: '決済の再試行を直す', done: 0, total: 5 }),
  row('docs-refresh', agent('done'), { ...steps, goal: 'README を更新する', done: 1, total: 3 }, {
    next: { id: 'sample-other', agent: 'claude', suggestions: [{ label: '手順を書き直す', prompt: '「インストール手順を書き直す」を進めてください' }] }
  })
]
const turn = { label: 'Owner の番', items: [
  { id: 'ask:old', workspace: 'checkout-retry', title: '再試行の回数の上限', path: '/work/checkout-retry', opened_at: '2026-11-16T20:43:00+09:00' },
  { id: 'ask:sample', workspace: focus.workspace, title: '絞り込みの初期値', path: focus.path, opened_at: '2026-11-18T20:31:00+09:00' }
] }
const light = flag === '--light'
const tokens = light
  ? '--orca-background:#fafafa;--orca-foreground:#171717;--orca-card:#fff;--orca-card-foreground:#171717;--orca-muted-foreground:#666;--orca-border:#ddd;--orca-radius:6px'
  : '--orca-background:#18181b;--orca-foreground:#fafafa;--orca-card:#202023;--orca-card-foreground:#fafafa;--orca-muted-foreground:#a1a1aa;--orca-border:#303035;--orca-radius:6px'
const style = await readFile(join(import.meta.dirname, '..', 'panel', 'style.css'), 'utf8')
await writeFile(out, `<!doctype html><html lang="ja" class="${light ? 'light' : 'dark'}"><head><meta charset="utf-8"><style>:root{${tokens}}${style}</style></head><body>${renderBody(buildModel({ path: focus.path }, workspaces, turn, now))}</body></html>\n`)
