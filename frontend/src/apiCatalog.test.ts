// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { epKey, filterGroups, GROUPS, PLACEHOLDER_IDS } from './apiCatalog.ts'
import { bashPayload, example } from './devhub.ts'

// Exactly the routes in app/main.py + app/api/routes.py (checked with FastAPI's router).
const REAL_ROUTES = [
  'GET /health',
  'POST /v1/find-and-verify', 'POST /v1/verify', 'GET /v1/runs/{run_id}', 'GET /v1/runs/{run_id}/evidence', 'GET /v1/runs',
  'POST /v1/agent/chat', 'GET /v1/agent/chat/stream',
  'GET /v1/runs/{run_id}/candidates/{candidate_id}/booking-context', 'POST /v1/bookings/preview', 'POST /v1/bookings', 'GET /v1/bookings/{booking_id}',
  'GET /v1/runs/{run_id}/candidates/{candidate_id}/action-context', 'POST /v1/orders/preview', 'POST /v1/orders', 'GET /v1/orders/{order_id}',
]
const all = GROUPS.flatMap((g) => g.items)
const IDS = { anyRun: 'r0', hotelRun: 'hotel1', hotelCand: 'c3', productRun: 'prod1', productCand: 'c5' }

test('catalogue documents exactly the implemented routes, in five groups', () => {
  assert.deepEqual(all.map((e) => `${e.method} ${e.path}`).sort(), [...REAL_ROUTES].sort())
  assert.deepEqual(GROUPS.map((g) => g.title), ['Service and health', 'Runs and evidence', 'Search and verification', 'Agent chat and streaming', 'Simulated bookings and orders'])
})

test('endpoint keys are unique and URL-safe', () => {
  const keys = all.map(epKey)
  assert.equal(new Set(keys).size, keys.length)
  assert.equal(epKey({ method: 'POST', path: '/v1/find-and-verify' }), 'post-v1-find-and-verify')
  for (const k of keys) assert.match(k, /^[a-z0-9-]+$/)
})

test('credit labels: only search/verify/chat use credits; actions are demo; reads are free', () => {
  const paid = all.filter((e) => e.cost === 'paid').map((e) => e.path).sort()
  assert.deepEqual(paid, ['/v1/agent/chat', '/v1/agent/chat/stream', '/v1/find-and-verify', '/v1/verify'])
  for (const e of all) if (/bookings|orders|context/.test(e.path)) assert.equal(e.cost, 'demo')
})

test('every POST example sends valid JSON and targets the right kind of run', () => {
  for (const e of all.filter((x) => x.method === 'POST' && x.ex)) {
    const body = bashPayload(example(e.ex!(IDS), 'bash')) as Record<string, unknown>
    assert.ok(body && typeof body === 'object', e.path)
    if (e.path.startsWith('/v1/bookings')) assert.deepEqual([body.run_id, body.candidate_id], ['hotel1', 'c3'])
    if (e.path.startsWith('/v1/orders')) assert.deepEqual([body.run_id, body.candidate_id], ['prod1', 'c5'])
  }
  const hotelCtx = all.find((e) => e.path.endsWith('booking-context'))!
  assert.equal(hotelCtx.ex!(IDS).path, '/v1/runs/hotel1/candidates/c3/booking-context')
})

test('endpoints without a runnable example explain why', () => {
  for (const e of all.filter((x) => !x.ex)) assert.ok(e.exNote, e.path)
  assert.match(example(GROUPS[2].items[0].ex!(PLACEHOLDER_IDS), 'powershell'), /Invoke-RestMethod -Method Post/)
})

test('filter by text and by cost', () => {
  const keys = (gs: ReturnType<typeof filterGroups>) => gs.flatMap((g) => g.items.map(epKey))
  assert.deepEqual(keys(filterGroups(GROUPS, 'health', 'all')), ['get-health'])
  assert.deepEqual(keys(filterGroups(GROUPS, 'orders post', 'all')), ['post-v1-orders-preview', 'post-v1-orders'])
  assert.equal(keys(filterGroups(GROUPS, '', 'paid')).length, 4)
  assert.equal(keys(filterGroups(GROUPS, '', 'free')).length, 4)
  assert.equal(keys(filterGroups(GROUPS, '', 'demo')).length, 8)
  assert.deepEqual(filterGroups(GROUPS, 'no-such-endpoint', 'all'), [])
  assert.equal(keys(filterGroups(GROUPS, 'STREAM', 'all'))[0], 'get-v1-agent-chat-stream')
})
