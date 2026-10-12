import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { apiFetch, AUTH_REQUIRED_EVENT, clearToken, getToken, getUser, isApiUrl, login, logout, me, register, rememberNext, setSession, setToken, takeExpiredNotice, takeNext } from './api.ts'

type Call = { url: string; init: RequestInit }
let calls: Call[] = []
let respond: (url: string) => Response = () => new Response('{}', { status: 200 })

const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}
const realFetch = (async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return respond(url) }) as typeof fetch
globalThis.fetch = realFetch

const auth = (c: Call) => new Headers(c.init.headers).get('Authorization')
const future = () => Date.now() / 1000 + 600

beforeEach(() => { calls = []; store.clear(); clearToken(); takeExpiredNotice(); respond = () => new Response('{}', { status: 200 }) })

test('token is attached to JSON, POST and streaming requests', async () => {
  setToken('tok.sig', future())
  await apiFetch('/v1/runs?limit=10')
  await apiFetch('/v1/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  await apiFetch('/v1/agent/chat/stream?message=hi', { headers: { Accept: 'text/event-stream' } })
  assert.deepEqual(calls.map(auth), ['Bearer tok.sig', 'Bearer tok.sig', 'Bearer tok.sig'])
  assert.equal(new Headers(calls[1].init.headers).get('Content-Type'), 'application/json')   // caller headers kept
  assert.equal(new Headers(calls[2].init.headers).get('Accept'), 'text/event-stream')
  assert.equal(calls[1].init.method, 'POST')
})

test('no token -> no Authorization header; expired token is ignored', async () => {
  await apiFetch('/v1/runs')
  setToken('old', Date.now() / 1000 - 1)
  await apiFetch('/v1/runs')
  assert.deepEqual(calls.map(auth), [null, null])
  assert.equal(getToken(), null)
})

test('token is never sent to a non-API origin', async () => {
  setToken('tok', future())
  assert.equal(isApiUrl('/v1/runs'), true)
  assert.equal(isApiUrl('http://localhost:8000/v1/runs'), true)
  assert.equal(isApiUrl('https://evil.example.com/v1/runs'), false)
  assert.equal(isApiUrl('//evil.example.com/x'), false)
  await apiFetch('https://evil.example.com/v1/runs')
  assert.equal(auth(calls[0]), null)
})

test('a 401 clears the token and signals sign-in', async () => {
  setToken('tok', future())
  let fired = 0
  const g = globalThis as Record<string, unknown>
  g.dispatchEvent = (e: Event) => { if (e.type === AUTH_REQUIRED_EVENT) fired++; return true }
  respond = () => new Response('{}', { status: 401 })
  await apiFetch('/v1/runs')
  assert.equal(getToken(), null)
  assert.equal(fired, 1)
  delete g.dispatchEvent
})

const USER = { user_id: 'u1', name: 'Ada', email: 'ada@example.com' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

test('sign-in: success stores the token and profile (never the password) and returns the user', async () => {
  respond = () => json({ token: 'p.s', expires_at: future(), user: USER })
  assert.deepEqual(await login(' ada@example.com ', 'a-long-password'), { ok: true, user: USER })
  assert.equal(getToken(), 'p.s')
  assert.deepEqual(getUser(), USER)
  assert.equal(calls[0].url, '/v1/auth/login')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { email: 'ada@example.com', password: 'a-long-password' })
  assert.ok(!JSON.stringify([...store.values()]).includes('a-long-password'))
})

test('sign-in: wrong credentials, throttling, server and network errors become clear messages', async () => {
  respond = () => json({ detail: { code: 'invalid_credentials', message: 'Email or password is incorrect.', errors: {} } }, 401)
  assert.deepEqual(await login('ada@example.com', 'nope'), { ok: false, status: 401, message: 'Email or password is incorrect.', errors: {} })
  assert.equal(getToken(), null)
  respond = () => json({ detail: { code: 'too_many_attempts', message: 'Too many failed sign-in attempts. Wait 15 minutes and try again.' } }, 429)
  assert.match((await login('a@b.co', 'x') as { message: string }).message, /Too many failed/)
  respond = () => json({ detail: 'boom' }, 503)
  assert.match((await login('a@b.co', 'x') as { message: string }).message, /unavailable/)
  globalThis.fetch = (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch
  const offline = await login('a@b.co', 'x')
  assert.equal(offline.ok, false)
  assert.match((offline as { message: string }).message, /could not be reached/)
  globalThis.fetch = realFetch
})

test('sign-up: success signs in; duplicate email and server field errors map onto fields', async () => {
  respond = () => json({ detail: { code: 'email_taken', message: 'An account with this email already exists. Sign in instead.',
    errors: { email: 'An account with this email already exists.' } } }, 409)
  const dup = await register('Ada', 'ada@example.com', 'a-long-password')
  assert.equal(dup.ok, false)
  assert.equal((dup as { status: number }).status, 409)
  assert.deepEqual((dup as { errors: object }).errors, { email: 'An account with this email already exists.' })
  respond = () => json({ detail: { code: 'invalid_signup', message: 'Please fix the highlighted fields.', errors: { password: 'Use at least 10 characters.', bogus: 'x' } } }, 422)
  assert.deepEqual((await register('Ada', 'ada@example.com', 'short') as { errors: object }).errors, { password: 'Use at least 10 characters.' })
  respond = () => json({ token: 'n.t', expires_at: future(), user: USER }, 201)
  assert.deepEqual(await register(' Ada ', 'ada@example.com', 'a-long-password'), { ok: true, user: USER })
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { name: 'Ada', email: 'ada@example.com', password: 'a-long-password' })
  assert.equal(getToken(), 'n.t')
})

test('session expiry: a token that runs out, or a 401 from the API, ends the session with a notice', async () => {
  setSession('t', Date.now() / 1000 + 600, USER)
  assert.equal(getToken(Date.now() / 1000 + 601), null)            // expired locally
  assert.equal(getUser(), null)
  assert.equal(takeExpiredNotice(), true)
  assert.equal(takeExpiredNotice(), false)                         // shown once
  setSession('t2', future(), USER)
  respond = () => json({ detail: { code: 'auth_required' } }, 401)
  await apiFetch('/v1/runs')                                         // revoked / expired on the server
  assert.equal(getToken(), null)
  assert.equal(takeExpiredNotice(), true)
})

test('regression: requests in flight after the token ran out do not erase the expiry notice', async () => {
  setSession('t', Date.now() / 1000 - 1, USER)                       // already expired
  respond = () => json({ detail: { code: 'auth_required' } }, 401)
  await apiFetch('/v1/runs')                                         // sent without a token -> 401
  await apiFetch('/v1/runs?limit=10')
  assert.equal(auth(calls[0]), null)
  assert.equal(takeExpiredNotice(), true)
})

test('logout revokes on the server, clears the session and shows no expiry notice', async () => {
  setSession('p.s', future(), USER)
  await logout()
  assert.equal(getToken(), null)
  assert.equal(getUser(), null)
  assert.equal(calls[0].url, '/v1/auth/logout')
  assert.equal(auth(calls[0]), 'Bearer p.s')
  assert.equal(takeExpiredNotice(), false)
})

test('me() refreshes the profile; after sign-in the app returns to the screen the visitor wanted', async () => {
  setSession('p.s', future(), null)
  respond = () => json({ ...USER, name: 'Ada L.' })
  assert.equal((await me())?.name, 'Ada L.')
  assert.equal(getUser()?.name, 'Ada L.')
  assert.equal(auth(calls[0]), 'Bearer p.s')
  rememberNext('/app/developers/trace')
  assert.equal(takeNext(), '/app/developers/trace')
  assert.equal(takeNext(), '/app')                                  // used once
  rememberNext('https://evil.example.com')                          // only in-app routes are remembered
  assert.equal(takeNext(), '/app')
})

test('every API call in the app goes through apiFetch (no raw fetch elsewhere)', () => {
  const dir = new URL('.', import.meta.url)
  const offenders = readdirSync(dir)
    .filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts') && f !== 'api.ts')
    .filter((f) => /(^|[^\w.])fetch\(|EventSource\(/.test(readFileSync(new URL(f, dir), 'utf8')))
  assert.deepEqual(offenders, [])
})

test('no secret-looking values or private keys in frontend source', () => {
  const dir = new URL('.', import.meta.url)
  const src = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.test.ts'))
    .map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n')
  assert.doesNotMatch(src, /VITE_[A-Z_]*(KEY|SECRET|PASSWORD|TOKEN)/)
  assert.doesNotMatch(src, /PROOFGATE_(DEMO_PASSWORD|SESSION_SECRET)\s*[:=]\s*['"][^'"]/)
})
