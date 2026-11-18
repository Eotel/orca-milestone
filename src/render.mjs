function escape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' }
const AGENT_STATES = { working: '作業中', waiting: '入力待ち', blocked: '入力待ち', done: '待機中' }
const FOOTER = '<footer><button type="button" data-board>ボードを開く</button><p class="status" role="status"></p></footer>'

function agentLabel(row) {
  const counts = Map.groupBy(row.agents, ({ agent, state }) => `${AGENT_NAMES[agent]} ${AGENT_STATES[state]}`)
  return [...counts].map(([label, agents]) => agents.length > 1 ? `${label} ×${agents.length}` : label).join('・')
}

function renderSteps(row) {
  const steps = row.steps
  if (steps.source === 'none') return ''
  const percent = steps.total === 0 ? 0 : Math.round(steps.done / steps.total * 100)
  const open = steps.items.filter((item) => item.status !== 'done')
  return `<section class="steps-card" data-key="${escape(`steps\n${row.path}\n${steps.goal}`)}"><div class="count"><span>step</span><strong>${escape(steps.done)} / ${escape(steps.total)}</strong></div>${steps.goal ? `<p class="goal">${escape(steps.goal)}</p>` : ''}<div class="bar"><div style="width:${percent}%"></div></div><ol class="steps">${open.map((item) => `<li class="${escape(item.status)}"><span class="mark">${item.status === 'in_progress' ? '●' : '○'}</span><span>${escape(item.text)}</span></li>`).join('')}</ol></section>`
}

function openedAt(value, now) {
  const date = new Date(value)
  const today = new Date(now)
  return date.toDateString() === today.toDateString()
    ? `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    : `${date.getMonth() + 1}/${date.getDate()}`
}

function renderAsk(ask, now) {
  const key = `${ask.id}\n${ask.revision}`
  const head = `<h2 class="count"><span>ask</span><time datetime="${escape(ask.opened_at)}">${openedAt(ask.opened_at, now)}</time></h2>`
  if (ask.can_answer === false) return `<section class="ask-card" data-key="${escape(`ask\n${key}`)}">${head}${(ask.questions.length > 0 ? ask.questions.map((question) => question.question) : [ask.text]).map((text) => `<p class="ask-text">${escape(text)}</p>`).join('')}</section>`
  const questions = ask.questions.map((question, position) => `<div class="question"><p class="ask">${escape(question.question)}</p><div class="options" role="group" aria-label="${escape(question.question)}">${question.options.map((option, index) => `<button type="button" class="action option" data-form="${escape(key)}" data-question="${position}" data-option="${index}" data-label="${escape(option.label)}" aria-pressed="false"><span class="label">${escape(option.label)}${option.label === question.recommended ? '<span class="recommended">推奨</span>' : ''}</span>${option.description ? `<span class="description">${escape(option.description)}</span>` : ''}</button>`).join('')}</div></div>`).join('')
  const body = ask.questions.length > 0 ? questions : `<p class="ask-text">${escape(ask.text)}</p><textarea data-text="${escape(key)}" aria-label="回答" rows="3"></textarea>`
  return `<section class="next ask-card" data-key="${escape(`ask\n${key}`)}" data-ask="${escape(ask.id)}" data-revision="${escape(ask.revision)}">${head}${body}<button type="button" class="submit" data-submit="${escape(key)}" data-count="${ask.questions.length}" disabled>回答を送信</button></section>`
}

function nextButton(row, index, content) {
  return `<button type="button" class="action" data-next="${escape(row.next.id)}" data-path="${escape(row.path)}" data-index="${index}">${content}</button>`
}

function renderNext(row) {
  if (!row.next) return ''
  return `<div class="next proposal" data-key="${escape(`next\n${row.path}\n${row.next.id}`)}"><h2>次の作業</h2><ol class="actions">${row.next.suggestions.map((suggestion, index) => `<li class="suggestion"><p>${escape(suggestion.prompt)}</p>${nextButton(row, index, `${AGENT_NAMES[row.next.agent]} に送る`)}</li>`).join('')}</ol></div>`
}

function elapsed(value, now) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60_000))
  if (minutes < 60) return `${minutes}分経過`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}時間経過`
  return `${Math.floor(minutes / 1440)}日経過`
}

function renderTurn({ label, items }, focusedPath, now) {
  const rows = items.filter((item) => !item.path || item.path !== focusedPath)
  if (rows.length === 0) return ''
  return `<section class="turn"><h2 class="count"><span>${escape(label)}</span><span>${items.length}</span></h2><ol class="rows">${rows.map((item) => `<li class="turn-row" data-key="${escape(item.id)}"><div class="turn-head"${item.path ? ` role="button" tabindex="0" data-open="${escape(item.path)}"` : ''}><span class="dot attention"></span><span class="name">${escape(item.workspace)}</span><span class="age">${elapsed(item.opened_at, now)}</span><span class="title" title="${escape(item.title)}">${escape(item.title)}</span></div></li>`).join('')}</ol></section>`
}

function renderOther(row) {
  const steps = row.steps.source === 'none' ? '' : `<span class="of">step ${escape(row.steps.done)} / ${escape(row.steps.total)}</span>`
  const next = row.next ? `<div class="next row-next" data-key="${escape(`next\n${row.path}\n${row.next.id}`)}"><p>${escape(row.next.suggestions[0].prompt)}</p>${nextButton(row, 0, `${AGENT_NAMES[row.next.agent]} に送る`)}</div>` : ''
  const state = row.agents.some((agent) => agent.state === 'working') ? 'working' : row.agents.some((agent) => ['waiting', 'blocked'].includes(agent.state)) ? 'waiting' : 'done'
  return `<li class="row ${state}" data-key="${escape(row.path)}"><div class="head" role="button" tabindex="0" data-open="${escape(row.path)}"><span class="dot ${state}"></span><span class="name">${escape(row.workspace)}</span><span class="row-agent">${escape(agentLabel(row))}</span>${steps}</div>${next}</li>`
}

export function renderBody(model) {
  if (model.unavailable) return `<main><p class="empty">ボードに接続できません ${escape(model.url)}</p></main>${FOOTER}`
  const row = model.focused
  const header = row ? `<header><h1>${escape(row.workspace)}</h1><span class="agent ${escape(row.agents[0]?.state ?? '')}">${escape(agentLabel(row))}</span></header>` : ''
  const asks = row ? [...row.asks].sort((a, b) => Date.parse(b.opened_at) - Date.parse(a.opened_at)).map((ask) => renderAsk(ask, model.now)).join('') : ''
  const others = model.others.length ? `<section class="others"><h2>ほかの workspace</h2><ol class="rows">${model.others.map(renderOther).join('')}</ol></section>` : ''
  return `<main>${header}${asks}${row ? renderSteps(row) + renderNext(row) : ''}${renderTurn(model.turn, row?.path, model.now)}${others}</main>${FOOTER}`
}
