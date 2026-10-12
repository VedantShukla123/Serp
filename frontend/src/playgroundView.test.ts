// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildCards, condTally, decisionHeading, journey, priceLabel, summarize } from './playgroundView.ts'
import { traceFromRun } from './replay.ts'

const att = (id: string, overall: string, v: Record<string, string>) => ({ candidate_id: id, candidate_name: id,
  verification: { overall_status: overall, requirements: Object.entries(v).map(([requirement_id, status]) => ({ requirement_id, status, reason: `${requirement_id} is ${status}` })) } })

// Shaped like stored run 5b051ed2235f (google_shopping); ranking order != verdict order.
const LAPTOP = {
  run_id: '5b051ed2235f', status: 'needs_human_review', request: 'Laptop under Rs 90,000, 32GB RAM, OLED display', action: 'buy_laptop',
  serpapi_meta: { engine: 'google_shopping' }, candidate_count: 3,
  requirements: [{ id: 'budget', description: 'Total price must be <= Rs 90,000' }, { id: 'ram', description: 'Must have 32GB RAM' }, { id: 'display', description: 'Must have an OLED display' }],
  candidates: [{ candidate_id: 'c4', name: 'LCD Laptop', price: '$984.99' }, { candidate_id: 'c5', name: 'GeekBook X14 Pro', price: '$899.00', seller: 'geekompc.com' }, { candidate_id: 'c9', name: 'Old Laptop' }],
  ranked_candidates: [{ candidate_id: 'c5', rank: 1 }, { candidate_id: 'c9', rank: 2 }, { candidate_id: 'c4', rank: 3 }],
  attempts: [att('c4', 'REJECTED', { budget: 'UNKNOWN', ram: 'SATISFIED', display: 'CONTRADICTED' }),
             att('c9', 'REJECTED', { budget: 'UNKNOWN', ram: 'CONTRADICTED', display: 'CONTRADICTED' }),
             att('c5', 'UNVERIFIED', { budget: 'UNKNOWN', ram: 'SATISFIED', display: 'SATISFIED' })],
  selected_candidate: { candidate_id: 'c5', name: 'GeekBook X14 Pro' }, verification: { overall_status: 'UNVERIFIED', requirements: [] },
}

test('cards follow ranking order and take status/conditions by candidate_id', () => {
  const cards = buildCards(traceFromRun(LAPTOP) as never)
  assert.deepEqual(cards.map((c) => [c.candidate_id, c.rank, c.status]), [['c5', 1, 'UNVERIFIED'], ['c9', 2, 'REJECTED'], ['c4', 3, 'REJECTED']])
  assert.deepEqual(cards[0].conditions.map((c) => c.status), ['UNKNOWN', 'SATISFIED', 'SATISFIED'])
  assert.equal(cards[0].conditions[0].reason, 'budget is UNKNOWN')
})

test('replayed cards keep the listed price; missing price stays null', () => {
  const cards = buildCards(traceFromRun(LAPTOP) as never)
  assert.equal(cards[0].price, '$899.00')
  assert.equal(cards[0].seller, 'geekompc.com')
  assert.equal(cards[1].price, null)
})

test('explanations are factual and specific to each candidate', () => {
  const [c5, c9, c4] = buildCards(traceFromRun(LAPTOP) as never)
  assert.equal(c5.explanation, 'Not confirmed by the evidence: Total price must be <= Rs 90,000.')
  assert.equal(c9.explanation, 'Evidence contradicts: Must have 32GB RAM and Must have an OLED display.')
  assert.equal(c4.explanation, 'Evidence contradicts: Must have an OLED display.')   // different reason from c9
})

test('needs-review summary: counts once, names the backend selection, never says verified', () => {
  const t = traceFromRun(LAPTOP) as never
  const s = summarize(t, buildCards(t), false)!
  assert.equal(s.tone, 'warn')
  assert.equal(s.title, 'No fully verified match — needs your review')
  assert.deepEqual(s.counts, { VERIFIED: 0, UNVERIFIED: 1, REJECTED: 2 })
  assert.equal(s.focus, 'c5')
  assert.match(s.body, /^Best available: GeekBook X14 Pro\. Not confirmed by the evidence: Total price/)
  assert.match(s.body, /2 options were rejected — each card shows which condition was contradicted\./)
  assert.doesNotMatch(s.body + ' ' + s.title, /Verified match found|is verified|met every required/i)
  assert.notEqual(s.tone, 'ok')
})

test('verified, no-match, error, direct and live summaries', () => {
  const verified = traceFromRun({ ...LAPTOP, status: 'verified', attempts: [att('c5', 'VERIFIED', { budget: 'SATISFIED', ram: 'SATISFIED', display: 'SATISFIED' })] }) as never
  assert.equal(summarize(verified, buildCards(verified), false)!.title, 'Verified match found')
  const none = traceFromRun({ ...LAPTOP, status: 'no_verified_match', candidates: [], ranked_candidates: [], attempts: [], selected_candidate: null, candidate_count: 0 }) as never
  const sNone = summarize(none, buildCards(none), false)!
  assert.equal(sNone.title, 'No eligible match'); assert.equal(sNone.body, 'The search returned no candidates.')
  const allRejected = traceFromRun({ ...LAPTOP, selected_candidate: { candidate_id: 'c9' } }) as never
  assert.match(summarize(allRejected, buildCards(allRejected), false)!.next, /rejected options cannot proceed/)
  const live = { requirements: [], candidateCount: null, candidates: [], ranked: [], verifying: null, verdicts: [], final: null, error: null, engine: null }
  assert.equal(summarize(live as never, [], true)!.title, 'Verifying…')
  assert.equal(summarize({ ...live, error: 'serpapi_failed' } as never, [], false)!.title, 'The run failed')
  assert.equal(summarize({ ...live, final: { status: 'direct', selected_candidate: null, verification: null, run_id: null } } as never, [], false)!.title, 'Answered directly')
  assert.equal(summarize(null, [], false), null)
})

test('unchecked candidates are explained, not given a status', () => {
  const t = traceFromRun({ ...LAPTOP, status: 'verified', attempts: [att('c5', 'VERIFIED', { budget: 'SATISFIED', ram: 'SATISFIED', display: 'SATISFIED' })] }) as never
  const cards = buildCards(t)
  assert.equal(cards[1].status, 'NOT_CHECKED')
  assert.match(cards[1].explanation, /^Not checked/)
})

test('journey stages: replayed run is complete; live run shows the active step', () => {
  const t = traceFromRun(LAPTOP) as never
  assert.deepEqual(journey(t, false).map((s) => s.state), ['done', 'done', 'done', 'done', 'done'])
  const mid = { requirements: [{}], candidateCount: 15, candidates: [], ranked: [{}], verifying: { candidate_id: 'c1' }, verdicts: [], final: null, error: null, engine: null }
  assert.deepEqual(journey(mid as never, true).map((s) => s.state), ['done', 'done', 'done', 'active', 'idle'])
  assert.deepEqual(journey(null, false).map((s) => s.state), ['idle', 'idle', 'idle', 'idle', 'idle'])
})

test('price label depends on the action type', () => {
  assert.equal(priceLabel('hotel'), 'per night, as listed')
  assert.equal(priceLabel('product'), 'as listed')
  assert.equal(priceLabel(null), 'as listed')
})

test('decision heading is plain and never overstates verification', () => {
  const t = traceFromRun(LAPTOP) as never
  const cards = buildCards(t)
  assert.equal(decisionHeading(summarize(t, cards, false)!, cards), 'Needs human review')
  const verified = traceFromRun({ ...LAPTOP, status: 'verified', attempts: [att('c5', 'VERIFIED', { budget: 'SATISFIED', ram: 'SATISFIED', display: 'SATISFIED' })] }) as never
  const vc = buildCards(verified)
  assert.equal(decisionHeading(summarize(verified, vc, false)!, vc), 'Verified')
  const allRejected = traceFromRun({ ...LAPTOP, selected_candidate: { candidate_id: 'c9' } }) as never
  const rc = buildCards(allRejected)
  assert.equal(decisionHeading(summarize(allRejected, rc, false)!, rc), 'No verified match')
  const none = traceFromRun({ ...LAPTOP, status: 'no_verified_match', candidates: [], ranked_candidates: [], attempts: [], selected_candidate: null, candidate_count: 0 }) as never
  assert.equal(decisionHeading(summarize(none, [], false)!, []), 'No verified match')
  const live = { requirements: [], candidateCount: null, candidates: [], ranked: [], verifying: null, verdicts: [], final: null, error: null, engine: null }
  assert.equal(decisionHeading(summarize({ ...live, error: 'serpapi_failed' } as never, [], false)!, []), 'The run failed')
  assert.equal(decisionHeading(summarize(live as never, [], true)!, []), 'Verifying…')
})

test('condition tally counts only checked conditions', () => {
  const t = traceFromRun(LAPTOP) as never
  const c9 = buildCards(t).find((c) => c.candidate_id === 'c9')!
  assert.match(condTally(c9), /^\d+ of \d+ confirmed/)
  assert.match(condTally(c9), /didn't match/)
  assert.equal(condTally({ ...c9, conditions: [] }), '')
})
