// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { canSimulate, DISCLAIMER, fmtMoney, nightsBetween, validateBookingForm, type BookingForm } from './booking.ts'

const TODAY = '2026-10-10'
const OK: BookingForm = { guest_name: 'Asha Rao', email: 'asha@example.com', guests: '2', check_in: '2026-10-17', check_out: '2026-10-20' }

test('valid form has no errors', () => {
  assert.deepEqual(validateBookingForm(OK, TODAY), {})
  assert.equal(nightsBetween(OK.check_in, OK.check_out), 3)
})

test('required fields and formats are validated', () => {
  const e = validateBookingForm({ guest_name: ' ', email: 'nope', guests: '0', check_in: '', check_out: '' }, TODAY)
  assert.deepEqual(Object.keys(e).sort(), ['check_in', 'check_out', 'email', 'guest_name', 'guests'])
  assert.ok(validateBookingForm({ ...OK, guests: '2.5' }, TODAY).guests)
  assert.ok(validateBookingForm({ ...OK, guests: '11' }, TODAY).guests)
})

test('dates: no past check-in, check-out after check-in, max 30 nights', () => {
  assert.equal(validateBookingForm({ ...OK, check_in: '2026-10-09' }, TODAY).check_in, 'Check-in cannot be in the past.')
  assert.equal(validateBookingForm({ ...OK, check_out: OK.check_in }, TODAY).check_out, 'Check-out must be after check-in.')
  assert.equal(validateBookingForm({ ...OK, check_out: '2026-12-31' }, TODAY).check_out, 'Stays are limited to 30 nights.')
  assert.equal(nightsBetween('2026-10-20', '2026-10-17'), null)
})

test('REJECTED can never simulate; UNVERIFIED/unchecked only after acknowledgement', () => {
  assert.equal(canSimulate('REJECTED', true), false)
  assert.equal(canSimulate('UNVERIFIED', false), false)
  assert.equal(canSimulate('UNVERIFIED', true), true)
  assert.equal(canSimulate('NOT_CHECKED', false), false)
  assert.equal(canSimulate('VERIFIED', false), true)
})

test('unknown prices render as Unknown, never as zero', () => {
  assert.equal(fmtMoney(null, 'INR'), 'Unknown')
  assert.equal(fmtMoney(undefined, 'INR'), 'Unknown')
  assert.equal(fmtMoney(3357, 'INR'), '₹3,357')
})

test('disclaimer text is exact', () => {
  assert.equal(DISCLAIMER, 'SIMULATED BOOKING — NO REAL RESERVATION CREATED — NO PAYMENT CHARGED')
})
