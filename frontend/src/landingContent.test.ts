// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LINKS, mostVisible, OUTCOMES, overall, PICK, REQS, STEPS } from './landingContent.ts'
import { parseRoute } from './route.ts'

test('every landing destination is a real route or an on-page anchor', () => {
  for (const [name, to] of Object.entries(LINKS)) {
    if (to.startsWith('scroll:')) { assert.equal(to, 'scroll:how', name); continue }
    const r = parseRoute('#' + to)
    assert.notEqual(r.page, 'landing', `${name} -> ${to} would fall back to the landing page`)
  }
  assert.deepEqual(parseRoute('#' + LINKS.navSignIn), { page: 'signin' })
  assert.deepEqual(parseRoute('#' + LINKS.navGetStarted), { page: 'signup' })
  assert.deepEqual(parseRoute('#' + LINKS.finalPrimary), { page: 'app', tab: 'assistant', sub: null, arg: null })
  assert.deepEqual(parseRoute('#' + LINKS.previewRun), { page: 'app', tab: 'developers', sub: 'trace', arg: 'c28bb2b65036' })
  assert.deepEqual(parseRoute('#' + LINKS.devMcp), { page: 'app', tab: 'developers', sub: 'mcp', arg: null })
})

test('CTAs within a section never duplicate each other', () => {
  assert.notEqual(LINKS.heroPrimary, LINKS.heroSecondary)
  assert.notEqual(LINKS.finalPrimary, LINKS.finalSecondary)
  assert.notEqual(LINKS.finalPrimary, LINKS.heroPrimary)          // the closing CTA is not a hero repeat
  assert.equal(new Set([LINKS.devRest, LINKS.devStream, LINKS.devMcp, LINKS.devSdks]).size, 4)
})

test('illustrations obey the real decision rule (contradiction rejects, unknown needs review)', () => {
  for (const o of OUTCOMES) assert.equal(overall(o.marks), o.status)
  assert.equal(PICK.verdicts.length, REQS.length)
  assert.equal(overall(PICK.verdicts), 'UNVERIFIED')                 // Silver Sands is never shown as verified
})

test('six steps from action to human review', () => {
  assert.deepEqual(STEPS.map((s) => s.id), ['action', 'reqs', 'evidence', 'jev', 'decision', 'review'])
})

test('active step follows the most visible block; nothing visible keeps the current one', () => {
  assert.equal(mostVisible([0, 0.2, 0.9, 0.1], 0), 2)
  assert.equal(mostVisible([0, 0, 0, 0], 3), 3)
  assert.equal(mostVisible([0.5, 0.5], 1), 0)
})
