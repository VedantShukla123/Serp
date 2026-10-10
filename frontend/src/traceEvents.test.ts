// Run with `npm test` (Node >= 22.18 strips TypeScript types natively).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isCandidateVerdict, rankedFromEvent, rankReasonFor } from './traceEvents.ts'

test('ranking event reads the backend `ranked_candidates` field and attaches names', () => {
  // Shape emitted by app/services/pipeline.py: {"type": "ranking", "ranked_candidates": [...], "model": ...}
  const p = {
    type: 'ranking',
    ranked_candidates: [
      { candidate_id: 'c3', rank: 1, reason: 'cheap' },
      { candidate_id: 'c9', rank: 2, reason: '' },
    ],
    model: 'm',
  }
  const ranked = rankedFromEvent(p, [{ candidate_id: 'c3', name: 'Silver Sands' }])
  assert.equal(ranked.length, 2)
  assert.deepEqual(ranked[0], { candidate_id: 'c3', rank: 1, reason: 'cheap', name: 'Silver Sands' })
  assert.equal(ranked[1].name, undefined) // unknown id keeps the id fallback in the UI
})

test('ranking event without a ranked list yields an empty shortlist', () => {
  assert.deepEqual(rankedFromEvent({ type: 'ranking' }, []), [])
})

test('run-level verdict event is not treated as a candidate row', () => {
  // Shape emitted at the end of run_find_and_verify.
  const runLevel = { type: 'verdict', status: 'needs_human_review', run_id: 'r1', selected_candidate_id: 'c3', attempts: 15 }
  assert.equal(isCandidateVerdict(runLevel), false)
  assert.equal(isCandidateVerdict({ type: 'verdict', status: 'no_verified_match', selected_candidate_id: null }), false)
})

test('candidate-level verdict event is a candidate row', () => {
  const perCandidate = { type: 'verdict', candidate_id: 'c12', overall_status: 'REJECTED', requirements: [] }
  assert.equal(isCandidateVerdict(perCandidate), true)
})


test('shortlist text comes only from the Jev status, never from the ranker reason', () => {
  assert.equal(rankReasonFor('VERIFIED'), 'Ranked as a relevant candidate; all required points verified.')
  assert.equal(rankReasonFor('verified'), 'Ranked as a relevant candidate; all required points verified.')
  assert.equal(rankReasonFor('UNVERIFIED'), 'Ranked as a relevant candidate; some required points remain unverified.')
  assert.equal(rankReasonFor('REJECTED'), 'Ranked as a relevant candidate; rejected because at least one required point was contradicted.')
  assert.equal(rankReasonFor(undefined), 'Ranked as a relevant candidate; not yet verified.')
})

test('unverified and rejected candidates never display an all-requirements-met claim', () => {
  for (const s of ['UNVERIFIED', 'REJECTED', undefined]) {
    assert.doesNotMatch(rankReasonFor(s), /meets all|all required points verified|beachfront|breakfast|cancellation/i)
  }
})
