// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { actionLabel, fmtListed, targetTypeOf, validateOrderForm } from './actionTypes.ts'
import { traceFromRun } from './replay.ts'

test('target type comes from target_type, then engine, then action — never a default hotel', () => {
  assert.equal(targetTypeOf({ target_type: 'product' }), 'product')
  assert.equal(targetTypeOf({ engine: 'google_shopping', action: 'book_hotel' }), 'product')
  assert.equal(targetTypeOf({ engine: 'google_hotels', action: 'search' }), 'hotel')
  assert.equal(targetTypeOf({ engine: 'google_maps' }), 'place')
  assert.equal(targetTypeOf({ engine: 'google_flights' }), 'generic')
  assert.equal(targetTypeOf({ action: 'buy_laptop' }), 'product')
  assert.equal(targetTypeOf({ action: 'search' }), null)
  assert.equal(targetTypeOf({}), null)
})

test('button labels follow the target type and Jev status', () => {
  assert.deepEqual(actionLabel('product', 'UNVERIFIED'), { text: 'Simulate order (needs review)', enabled: true })
  assert.deepEqual(actionLabel('product', 'VERIFIED'), { text: 'Simulate order', enabled: true })
  assert.deepEqual(actionLabel('hotel', 'UNVERIFIED'), { text: 'Simulate hotel booking (needs review)', enabled: true })
  assert.deepEqual(actionLabel('product', 'REJECTED'), { text: 'Rejected — not available', enabled: false })
  assert.equal(actionLabel(null, 'VERIFIED').text, 'Review result')
  assert.equal(actionLabel('place', 'VERIFIED').text, 'Review result')
  for (const t of ['product', 'place', 'generic', null] as const) assert.doesNotMatch(actionLabel(t, 'VERIFIED').text, /hotel|booking/i)
})

test('order form validation', () => {
  assert.deepEqual(validateOrderForm({ buyer_name: 'A', email: 'a@b.co', quantity: '2', delivery_address: '12 MG Road' }), {})
  const e = validateOrderForm({ buyer_name: ' ', email: 'x', quantity: '0', delivery_address: 'x' })
  assert.deepEqual(Object.keys(e).sort(), ['buyer_name', 'delivery_address', 'email', 'quantity'])
  assert.ok(validateOrderForm({ buyer_name: 'A', email: 'a@b.co', quantity: '1.5', delivery_address: '12 MG Road' }).quantity)
})

test('listed money is never converted and unknown stays unknown', () => {
  assert.equal(fmtListed(179980, 'INR'), 'INR 1,79,980.00')
  assert.equal(fmtListed(1286.01, null), 'Unknown')
  assert.equal(fmtListed(null, 'USD'), 'Unknown')
})

test('replayed stored runs carry their target type (old runs derive it from the engine)', () => {
  const base = { run_id: 'r', status: 'needs_human_review', request: 'q' }
  assert.equal(traceFromRun({ ...base, target_type: 'product' }).final.target_type, 'product')
  assert.equal(traceFromRun({ ...base, serpapi_meta: { engine: 'google_shopping' } }).final.target_type, 'product')
  assert.equal(traceFromRun({ ...base, serpapi_meta: { engine: 'google_hotels' } }).final.target_type, 'hotel')
  assert.equal(traceFromRun(base).final.target_type, null)
})
