// Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bashPayload, checkRunId, describeError, example, latestGuard, loginExample, statusCounts, traceRows } from './devhub.ts'

const FIND = { method: 'POST' as const, path: '/v1/find-and-verify', body: { request: "Hotel in Goa, sea view, it's fine", action: 'book_hotel', max_candidates: 5 } }

test('bash POST examples send valid JSON, including apostrophes', () => {
  const cmd = example(FIND, 'bash')
  assert.match(cmd, /^curl -s -X POST 'http:\/\/localhost:8000\/v1\/find-and-verify'/)
  assert.deepEqual(bashPayload(cmd), FIND.body)
})

test('PowerShell examples never use the curl alias or hand-quoted JSON', () => {
  const cmd = example(FIND, 'powershell')
  assert.match(cmd, /^\$body = @\{/)
  assert.match(cmd, /ConvertTo-Json -Depth 10/)
  assert.match(cmd, /\$res = Invoke-RestMethod -Method Post -Uri "http:\/\/localhost:8000\/v1\/find-and-verify"/)
  assert.match(cmd, /ConvertTo-Json -Depth 10 -InputObject \$res$/)
  assert.doesNotMatch(cmd, /(^|\s)curl\s/)
  assert.match(cmd, /max_candidates = 5/)
  assert.equal(example({ method: 'GET', path: '/health' }, 'powershell'), '$res = Invoke-RestMethod "http://localhost:8000/health"\nConvertTo-Json -Depth 10 -InputObject $res')
  assert.match(example({ method: 'GET', path: '/v1/agent/chat/stream?message=hi', stream: true }, 'powershell'), /^curl\.exe -N /)
})

test('PowerShell lists array endpoints as a table (no {value, Count} wrapper)', () => {
  assert.equal(example({ method: 'GET', path: '/v1/runs?limit=5', table: ['run_id', 'created_at', 'request'] }, 'powershell'),
    '(Invoke-RestMethod "http://localhost:8000/v1/runs?limit=5" -Headers @{ Authorization = "Bearer $env:PROOFGATE_TOKEN" }) | Format-Table run_id, created_at, request -AutoSize')
  assert.equal(example({ method: 'GET', path: '/v1/runs?limit=5', table: ['run_id'] }, 'bash'), `curl -s -H "Authorization: Bearer $PROOFGATE_TOKEN" 'http://localhost:8000/v1/runs?limit=5'`)
})

test('protected examples send the bearer token; public ones do not', () => {
  for (const shell of ['bash', 'powershell'] as const) {
    for (const ex of [FIND, { method: 'GET' as const, path: '/v1/runs/abc/evidence' }, { method: 'GET' as const, path: '/v1/agent/chat/stream?message=hi', stream: true }]) {
      assert.match(example(ex, shell), /Authorization\s*[:=]\s*"?Bearer \$(env:)?PROOFGATE_TOKEN/, `${shell} ${ex.path}`)
    }
    assert.doesNotMatch(example({ method: 'GET', path: '/health' }, shell), /Authorization/)
  }
  assert.deepEqual(bashPayload(example(FIND, 'bash')), FIND.body)        // header line does not break the payload
})

test('login example: real route, email + password fields, prompts for both and never embeds a credential', () => {
  for (const shell of ['bash', 'powershell'] as const) {
    const cmd = loginExample(shell)
    assert.match(cmd, /http:\/\/localhost:8000\/v1\/auth\/login/)
    assert.match(cmd, /"?email"?\s*[:=]/)
    assert.match(cmd, /"?password"?\s*[:=]/)
    assert.match(cmd, /PROOFGATE_TOKEN/)
    assert.match(cmd, shell === 'bash' ? /read -rp 'Email: '.*read -rsp 'Password: '/ : /Read-Host 'Email'[\s\S]*Read-Host 'Password' -AsSecureString/)
    assert.doesNotMatch(cmd, /demo/i)
  }
})

test('PowerShell escapes $ and quotes inside strings', () => {
  const cmd = example({ method: 'POST', path: '/x', body: { message: 'cost $5 "now"', ok: true, n: null } }, 'powershell')
  assert.match(cmd, /message = "cost `\$5 `"now`""/)
  assert.match(cmd, /ok = \$true/)
  assert.match(cmd, /n = \$null/)
})

test('run id validation', () => {
  assert.deepEqual(checkRunId('  c28bb2b65036 '), { ok: true, id: 'c28bb2b65036' })
  assert.equal(checkRunId('').ok, false)
  assert.equal(checkRunId('../etc/passwd').ok, false)
  assert.equal(checkRunId('a b').ok, false)
})

test('errors are classified for display', () => {
  assert.equal(describeError(null, 404).kind, 'not_found')
  assert.equal(describeError(null, 500).kind, 'server')
  assert.equal(describeError(null, 422).kind, 'http')
  assert.equal(describeError(new DOMException('x', 'AbortError')).kind, 'timeout')
  assert.equal(describeError(new TypeError('Failed to fetch')).kind, 'network')
})

test('latest guard ignores responses from older requests', () => {
  const g = latestGuard()
  const a = g.next(); const b = g.next()
  assert.equal(g.isCurrent(a), false)
  assert.equal(g.isCurrent(b), true)
})

test('trace rows match by candidate_id, keep unchecked and unranked candidates', () => {
  const rows = traceRows({
    run_id: 'r', status: 'verified', request: 'q',
    candidates: [{ candidate_id: 'c1', name: 'A', price: '₹1' }, { candidate_id: 'c2', name: 'B' }, { candidate_id: 'c3', name: 'C' }, { candidate_id: 'c9', name: 'Z' }],
    ranked_candidates: [{ candidate_id: 'c3', rank: 2 }, { candidate_id: 'c2', rank: 1 }, { candidate_id: 'c1', rank: 3 }],
    attempts: [
      { candidate_id: 'c2', verification: { overall_status: 'REJECTED', requirements: [{ requirement_id: 'budget', status: 'CONTRADICTED' }] } },
      { candidate_id: 'c3', verification: { overall_status: 'VERIFIED', requirements: [{ requirement_id: 'budget', status: 'SATISFIED' }] } },
    ],
  })
  assert.deepEqual(rows.map((r) => [r.candidate_id, r.rank, r.name, r.status]), [
    ['c2', 1, 'B', 'REJECTED'], ['c3', 2, 'C', 'VERIFIED'], ['c1', 3, 'A', 'NOT_CHECKED'], ['c9', null, 'Z', 'NOT_CHECKED'],
  ])
  assert.equal(rows[0].verdicts.budget.status, 'CONTRADICTED')
  assert.deepEqual(rows[2].verdicts, {})
  assert.deepEqual(statusCounts(rows), { VERIFIED: 1, UNVERIFIED: 0, REJECTED: 1, NOT_CHECKED: 2 })
})

test('trace rows tolerate a run with no candidates', () => {
  assert.deepEqual(traceRows({ run_id: 'r', status: 'no_verified_match', request: 'q' }), [])
})

import { initialRun, missingStatus, RUNS_PAGE, shortId } from './devhub.ts'

test('short run ids', () => {
  assert.equal(shortId('c28bb2b65036'), 'c28bb2b6…')
  assert.equal(shortId('legacy1'), 'legacy1')
})

test('inspector auto-opens the newest run only when nothing is selected', () => {
  const rows = [{ run_id: 'new1' }, { run_id: 'old1' }]
  assert.equal(initialRun(null, rows), 'new1')
  assert.equal(initialRun('old1', rows), null)
  assert.equal(initialRun(null, []), null)
})

test('statuses are fetched only for visible rows that are not known yet', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ run_id: `r${i}` }))
  assert.equal(RUNS_PAGE, 8)
  assert.deepEqual(missingStatus(rows, RUNS_PAGE, { r0: 'verified', r3: 'x' }), ['r1', 'r2', 'r4', 'r5', 'r6', 'r7'])
  assert.deepEqual(missingStatus(rows, 2, {}), ['r0', 'r1'])
})

import { API_BASE, API_ORIGIN, apiUrl } from './devhub.ts'

test('API location: same-origin by default, VITE_API_BASE_URL-style origin when given', () => {
  // under node there is no Vite env, i.e. VITE_API_BASE_URL unset
  assert.equal(API_ORIGIN, '')
  assert.equal(API_BASE, 'http://localhost:8000')
  assert.equal(apiUrl('/v1/runs'), '/v1/runs')
  assert.equal(apiUrl('/v1/runs', 'https://api.example.com/'), 'https://api.example.com/v1/runs')
  assert.equal(apiUrl('/health', 'https://api.example.com'), 'https://api.example.com/health')
})
