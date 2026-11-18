export function openOnPress(root, open, openBoard) {
  let opening = false
  root.addEventListener('click', async (event) => {
    const board = event.target.closest('[data-board]')
    if (board) {
      if (opening) return
      opening = true
      board.disabled = true
      let opened = false
      try { opened = (await openBoard()).opened } catch {}
      opening = false
      board.disabled = false
      root.querySelector('footer .status').textContent = opened ? '' : 'ボードを開けませんでした。'
      return
    }
    const head = event.target.closest('[data-open]')
    if (head) open(head.getAttribute('data-open'))
  })
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (!event.target.hasAttribute('data-open')) return
    event.preventDefault()
    open(event.target.getAttribute('data-open'))
  })
}
