// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PASSWORD_MAX, PASSWORD_MIN, validateSignIn, validateSignUp } from './authForms.ts'
import { parseRoute } from './route.ts'
import { getRecognitionCtor, mergeTranscript, speechErrorMessage } from './speech.ts'
import { pipelineStages } from './traceEvents.ts'

const base = { requirements: [], candidateCount: null, ranked: [], verifying: null, verdicts: [], final: null, error: null }

test('pipeline: nothing received yet -> first stage active only while live', () => {
  assert.deepEqual(pipelineStages(base, true), { understand: 'active', search: 'idle', rank: 'idle', verify: 'idle', decide: 'idle' })
  assert.deepEqual(pipelineStages(null, true).understand, 'idle')
})

test('pipeline: stages complete only from real events', () => {
  const mid = { ...base, requirements: [{}], candidateCount: 15, ranked: [{}], verifying: { candidate_id: 'c3' } }
  assert.deepEqual(pipelineStages(mid, true), { understand: 'done', search: 'done', rank: 'done', verify: 'active', decide: 'idle' })
})

test('pipeline: final with zero candidates marks unreached stages skipped, never done', () => {
  const t = { ...base, requirements: [{}], candidateCount: 0, final: { status: 'no_verified_match' } }
  assert.deepEqual(pipelineStages(t, false), { understand: 'done', search: 'done', rank: 'skipped', verify: 'skipped', decide: 'done' })
})

test('pipeline: error marks the stage that was in progress', () => {
  const t = { ...base, requirements: [{}], error: 'serpapi_failed' }
  assert.equal(pipelineStages(t, false).search, 'error')
  assert.equal(pipelineStages(t, false).decide, 'idle')
})

test('speech: detects standard and webkit-prefixed constructors, null when unsupported', () => {
  class R {}
  assert.equal(getRecognitionCtor({ SpeechRecognition: R }), R)
  assert.equal(getRecognitionCtor({ webkitSpeechRecognition: R }), R)
  assert.equal(getRecognitionCtor({}), null)
  assert.equal(getRecognitionCtor(undefined), null)
})

test('speech: transcript is appended for review, never replaces typed text', () => {
  assert.equal(mergeTranscript('', ' hotel in Goa '), 'hotel in Goa')
  assert.equal(mergeTranscript('Find me a', 'hotel in Goa'), 'Find me a hotel in Goa')
  assert.equal(mergeTranscript('typed', '   '), 'typed')
})

test('speech: permission denial has a clear message', () => {
  assert.match(speechErrorMessage('not-allowed'), /blocked/)
  assert.match(speechErrorMessage('weird'), /still type/)
})

test('sign-in form: email and password are required; nothing else is checked client-side', () => {
  assert.deepEqual(Object.keys(validateSignIn({ email: 'x', password: '' })).sort(), ['email', 'password'])
  assert.deepEqual(validateSignIn({ email: ' a@b.co ', password: 'x' }), {})          // the server judges the password
  assert.ok(validateSignIn({ email: 'a@b.co', password: 'x'.repeat(PASSWORD_MAX + 1) }).password)
})

test('sign-up form mirrors the server rules (name, email, 10–128 char password, matching confirmation)', () => {
  const e = validateSignUp({ name: '', email: 'a@b', password: 'short', confirm: 'nope' })
  assert.deepEqual(Object.keys(e).sort(), ['confirm', 'email', 'name', 'password'])
  assert.equal(PASSWORD_MIN, 10)
  assert.match(validateSignUp({ name: 'A', email: 'a@b.co', password: '123456789', confirm: '123456789' }).password!, /at least 10/)
  assert.ok(validateSignUp({ name: 'A', email: 'a@b.co', password: ' '.repeat(12), confirm: ' '.repeat(12) }).password)
  assert.ok(validateSignUp({ name: 'A', email: 'a@b.co', password: 'x'.repeat(129), confirm: 'x'.repeat(129) }).password)
  assert.ok(validateSignUp({ name: 'A'.repeat(101), email: 'a@b.co', password: 'a-long-password', confirm: 'a-long-password' }).name)
  assert.equal(validateSignUp({ name: 'Ada', email: 'a@b.co', password: 'a-long-password', confirm: 'a-long-passworD' }).confirm, 'Passwords do not match.')
  assert.deepEqual(validateSignUp({ name: 'Ada', email: 'ada@example.com', password: 'a-long-password', confirm: 'a-long-password' }), {})
})

test('routes', () => {
  assert.deepEqual(parseRoute(''), { page: 'landing' })
  assert.deepEqual(parseRoute('#/signin'), { page: 'signin' })
  assert.deepEqual(parseRoute('#/app'), { page: 'app', tab: 'assistant', sub: null, arg: null })
  assert.deepEqual(parseRoute('#/app/playground'), { page: 'app', tab: 'playground', sub: null, arg: null })
  assert.deepEqual(parseRoute('#/app/developers/mcp'), { page: 'app', tab: 'developers', sub: 'mcp', arg: null })
  assert.deepEqual(parseRoute('#/app/developers/trace/c28bb2b65036'), { page: 'app', tab: 'developers', sub: 'trace', arg: 'c28bb2b65036' })
  assert.deepEqual(parseRoute('#/nope'), { page: 'landing' })
})

import { traceFromRun } from './replay.ts'

test('replay: stored run maps to a trace by candidate_id with no invented statuses', () => {
  const t = traceFromRun({
    run_id: 'r1', status: 'needs_human_review', request: 'goa', candidate_count: 3,
    requirements: [{ id: 'budget', description: '<= 10000' }, { id: 'guests', description: '2 guests' }],
    candidates: [{ candidate_id: 'c1', name: 'A' }, { candidate_id: 'c2', name: 'B' }, { candidate_id: 'c3', name: 'C' }],
    ranked_candidates: [{ candidate_id: 'c2', rank: 1 }, { candidate_id: 'c1', rank: 2 }, { candidate_id: 'c3', rank: 3 }],
    attempts: [
      { candidate_id: 'c2', candidate_name: 'c2', verification: { overall_status: 'UNVERIFIED', requirements: [{ requirement_id: 'budget', status: 'SATISFIED' }, { requirement_id: 'guests', status: 'UNKNOWN' }] } },
      { candidate_id: 'c1', verification: { overall_status: 'REJECTED', requirements: [{ requirement_id: 'budget', status: 'CONTRADICTED' }] } },
    ],
    selected_candidate: { candidate_id: 'c2', name: 'B' },
    verification: { overall_status: 'UNVERIFIED', requirements: [] },
  })
  assert.deepEqual(t.ranked.map((r) => [r.candidate_id, r.name]), [['c2', 'B'], ['c1', 'A'], ['c3', 'C']])
  assert.deepEqual(t.verdicts.map((v) => [v.candidate_id, v.candidate_name, v.overall_status]), [['c2', 'B', 'UNVERIFIED'], ['c1', 'A', 'REJECTED']])
  assert.deepEqual(t.rejectedIds, ['c1'])
  assert.equal(t.final.run_id, 'r1')
  assert.equal(t.final.status, 'needs_human_review')
  assert.equal(t.candidateCount, 3)
  // c3 was never checked: no verdict is created for it
  assert.equal(t.verdicts.find((v) => v.candidate_id === 'c3'), undefined)
})
