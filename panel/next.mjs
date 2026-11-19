export const SETTLE_MS = 1500

const REFUSALS = {
  stale: '次の作業が変わったため送信しませんでした。',
  typing: 'Codex の入力欄に未送信のテキストがあるため送信しませんでした。',
  changed: 'ask が変わったため送信しませんでした。',
  timeout: '送信の結果を確認できませんでした。',
  failed: '送信に失敗しました。'
}

const UNREPEATABLE = new Set(['changed', 'timeout'])
const repeatable = (outcome) => !outcome?.sent && !UNREPEATABLE.has(outcome?.reason)

function refusalOf({ reason, message }) {
  return reason === 'failed' && message ? REFUSALS.failed + message : REFUSALS[reason] ?? REFUSALS.failed
}

function statusOf(waiting, outcome) {
  if (waiting) return { state: 'sending', text: '送信中…' }
  if (outcome?.sent === true) return { state: 'sent', text: '送信しました。' }
  if (outcome?.sent === false) return { state: 'refused', text: refusalOf(outcome) }
  return null
}

function offerOf(element) {
  return element.getAttribute('data-next') ?? element.getAttribute('data-form') ?? element.getAttribute('data-submit')
}

export function sendOnPress(root, send, { answerAsk, now = Date.now, settleMs = SETTLE_MS, later = setTimeout } = {}) {
  const picks = new Map()
  const drafts = new Map()
  const arrived = new Map()
  const outcomes = new Map()
  const pending = new Set()
  const settling = (offer) => now() - (arrived.get(offer) ?? -Infinity) < settleMs
  for (const element of root.querySelectorAll('[data-next], [data-form], [data-submit]')) arrived.set(offerOf(element), -Infinity)

  function settle() {
    const shown = new Set([...root.querySelectorAll('[data-next], [data-form], [data-submit]')].map(offerOf))
    for (const offer of arrived.keys()) {
      if (shown.has(offer)) continue
      arrived.delete(offer)
      picks.delete(offer)
      drafts.delete(offer)
      outcomes.delete(offer)
    }
    for (const offer of shown) {
      if (arrived.has(offer)) continue
      arrived.set(offer, now())
      later(restore, settleMs + 50)
    }
  }

  function restore() {
    settle()
    for (const next of root.querySelectorAll('.next')) {
      const control = next.querySelector('[data-next], [data-submit]')
      const key = offerOf(control)
      const outcome = outcomes.get(key)
      next.classList.toggle('settling', settling(key))
      next.classList.toggle('busy', pending.has(key) || !repeatable(outcome))
      for (const option of next.querySelectorAll('[data-option]')) {
        const chosen = picks.get(key)?.[Number(option.dataset.question)] === Number(option.dataset.option)
        option.classList.toggle('chosen', chosen)
        option.setAttribute('aria-pressed', String(chosen))
      }
      const textarea = next.querySelector('textarea')
      if (textarea) textarea.value = drafts.get(key) ?? ''
      const submit = next.querySelector('[data-submit]')
      if (submit) {
        const count = Number(submit.dataset.count)
        const complete = count > 0 ? (picks.get(key) ?? []).filter((pick) => pick !== undefined).length === count : Boolean(drafts.get(key)?.trim())
        submit.disabled = !complete || pending.has(key) || !repeatable(outcome)
      }
      const sending = pending.has(key) || outcome?.sent === true
      for (const button of next.querySelectorAll('[data-next], [data-submit]')) {
        button.classList.toggle('sending', sending && (button.hasAttribute('data-submit') || Number(button.dataset.index) === outcome?.index))
      }
      const shown = statusOf(pending.has(key), outcome)
      if (shown) {
        let status = next.querySelector('.status')
        if (!status) {
          status = next.ownerDocument.createElement('p')
          status.className = 'status'
          status.setAttribute('role', 'status')
          next.appendChild(status)
        }
        status.dataset.state = shown.state
        status.textContent = shown.text
      } else {
        next.querySelector('.status')?.remove()
      }
    }
  }

  async function deliver(element, request, answer) {
    const key = offerOf(element)
    pending.add(key)
    outcomes.set(key, { index: request.index })
    restore()
    let result
    try { result = await (answer ? answerAsk(request) : send(request)) } catch (error) { result = { sent: false, reason: error?.code === 'timeout' ? 'timeout' : 'failed' } }
    pending.delete(key)
    outcomes.set(key, { ...result, index: request.index })
    restore()
  }

  root.addEventListener('input', (event) => {
    if (!event.target.matches('[data-text]')) return
    drafts.set(event.target.dataset.text, event.target.value)
    restore()
  })

  root.addEventListener('click', (event) => {
    const pressed = event.target.closest('[data-next], [data-form], [data-submit]')
    if (!pressed) return
    const key = offerOf(pressed)
    if (settling(key) || pending.has(key) || !repeatable(outcomes.get(key))) return
    if (pressed.hasAttribute('data-option')) {
      const chosen = picks.get(key) ?? []
      chosen[Number(pressed.dataset.question)] = Number(pressed.dataset.option)
      picks.set(key, chosen)
      restore()
      return
    }
    if (pressed.hasAttribute('data-submit')) {
      if (pressed.disabled) return
      const card = pressed.closest('[data-ask]')
      const answers = (picks.get(key) ?? []).map((index, question) => ({
        question, label: [...card.querySelectorAll('[data-option]')].find((option) => Number(option.dataset.question) === question && Number(option.dataset.option) === index).dataset.label
      }))
      void deliver(pressed, { id: card.dataset.ask, revision: Number(card.dataset.revision), answers, text: drafts.get(key) ?? '' }, true)
      return
    }
    void deliver(pressed, { path: pressed.dataset.path, offer: pressed.dataset.next, index: Number(pressed.dataset.index) }, false)
  })

  restore()
  return { restore }
}
