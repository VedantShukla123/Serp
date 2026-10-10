import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { apiFetch, AUTH_REQUIRED_EVENT, clearToken, getToken, isApiUrl, login, logout, setToken } from './api.ts'

type Call = { url: string; init: RequestInit }
let calls: Call[] = []
let respond: (url: string) => Response = () => new Response('{}', { status: 200 })

const store = new Map<string, string>()
;(globalThis as Record<string, unknown>).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}
globalThis.fetch = (async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return respond(url) }) as typeof fetch

const auth = (c: Call) => new Headers(c.init.headers).get('Authorization')
const future = () => Date.now() / 1000 + 600

beforeEach(() => { calls = []; store.clear(); clearToken(); respond = () => new Response('{}', { status: 200 }) })

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

test('login stores the server token; failure surfaces the server message; logout revokes and clears', async () => {
  respond = () => new Response(JSON.stringify({ detail: { message: 'That demo password is not correct.' } }), { status: 401 })
  assert.deepEqual(await login('nope'), { ok: false, message: 'That demo password is not correct.' })
  assert.equal(getToken(), null)
  respond = () => new Response(JSON.stringify({ token: 'p.s', expires_at: future() }), { status: 200 })
  assert.deepEqual(await login('right'), { ok: true })
  assert.equal(getToken(), 'p.s')
  assert.match(String(calls[1].init.body), /"password":"right"/)
  assert.ok(!JSON.stringify([...store.values()]).includes('right'))      // password never stored
  await logout()
  assert.equal(getToken(), null)
  assert.equal(calls[2].url, '/v1/auth/logout')
  assert.equal(auth(calls[2]), 'Bearer p.s')
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
