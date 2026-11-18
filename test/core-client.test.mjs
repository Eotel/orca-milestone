import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCoreClient } from '../src/core-client.mjs'

test('uses the given board URL and otherwise the local board', async () => {
  const urls = []
  const fetch = async (url) => { urls.push(url); return Response.json({ version: 1, items: [] }) }
  await createCoreClient({ fetch, url: 'http://board.test:17317' }).turn()
  await createCoreClient({ fetch, url: undefined }).turn()
  assert.deepEqual(urls, ['http://board.test:17317/api/v1/turn', 'http://127.0.0.1:7317/api/v1/turn'])
})

test('reads both core resources and posts exact bodies with the milestone client header', async () => {
  const requests = []
  const client = createCoreClient({
    url: 'http://board.test:17317/',
    fetch: async (url, options) => {
      requests.push([url, options])
      return Response.json({ version: 1, sent: true })
    }
  })
  await client.workspaces()
  await client.turn()
  await client.sendNext({ path: '/work/app', offer: 'abc', index: 1 })
  await client.answerAsk({ id: 'ask:a/b', revision: 3, answers: [{ question: 0, label: '今週' }], text: '' })
  assert.deepEqual(requests.map(([url]) => url), [
    'http://board.test:17317/api/v1/workspaces', 'http://board.test:17317/api/v1/turn',
    'http://board.test:17317/api/v1/workspaces/next', 'http://board.test:17317/api/v1/asks/ask%3Aa%2Fb/answer'
  ])
  for (const [, options] of requests.slice(2)) {
    assert.equal(options.method, 'POST')
    assert.equal(options.headers['X-Orca-Board-Client'], 'milestone')
    assert.equal(options.headers['Content-Type'], 'application/json')
  }
  assert.deepEqual(JSON.parse(requests[2][1].body), { path: '/work/app', offer: 'abc', index: 1 })
  assert.deepEqual(JSON.parse(requests[3][1].body), { revision: 3, answers: [{ question: 0, label: '今週' }], text: '' })
})

test('keeps next refusal details and exposes HTTP failures including ask revision conflicts', async () => {
  const client = createCoreClient({ fetch: async (url) => {
    if (url.endsWith('/next')) return Response.json({ sent: false, reason: 'failed', message: 'FAILED: closed' }, { status: 502 })
    return Response.json({ error: 'changed' }, { status: 409 })
  } })
  assert.deepEqual(await client.sendNext({}), { sent: false, reason: 'failed', message: 'FAILED: closed' })
  await assert.rejects(client.answerAsk({ id: 'ask:a', revision: 1, answers: [], text: 'x' }), { status: 409 })
  await assert.rejects(client.workspaces(), { status: 409 })
})

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('SSE handles split UTF-8, CRLF and multiple events, and stop aborts the connection', async () => {
  let controller
  let signal
  let changed = 0
  const client = createCoreClient({ url: 'http://board.test', fetch: async (url, options) => {
    assert.equal(url, 'http://board.test/events')
    signal = options.signal
    return new Response(new ReadableStream({ start(value) { controller = value } }))
  } })
  const stop = client.listen(() => { changed += 1 })
  await flush()
  const bytes = new TextEncoder().encode(': あ\r\nevent: changed\r\ndata: {}\r\n\r\nevent: ignored\n\nevent: changed\n\n')
  controller.enqueue(bytes.slice(0, 3))
  controller.enqueue(bytes.slice(3, 25))
  controller.enqueue(bytes.slice(25))
  await flush()
  assert.equal(changed, 2)
  stop()
  assert.equal(signal.aborted, true)
  controller.close()
})

test('SSE reconnects with a growing delay capped at 30 seconds and stop cancels retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const client = createCoreClient({ fetch: async () => { calls += 1; throw new Error('offline') } })
  const stop = client.listen(() => {})
  await flush()
  assert.equal(calls, 1)
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    t.mock.timers.tick(delay - 1)
    await flush()
    const before = calls
    t.mock.timers.tick(1)
    await flush()
    assert.equal(calls, before + 1)
  }
  stop()
  t.mock.timers.tick(30000)
  await flush()
  assert.equal(calls, 8)
})
