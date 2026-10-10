/* The one place the browser talks to the ProofGate API (no React) — unit-tested.
   Attaches the demo-session bearer token to every API request (JSON, streaming SSE,
   simulated actions, Developer tools). The token is a short-lived server-signed value kept
   in sessionStorage (cleared when the tab closes) — never in a VITE_ variable. */
import { API_BASE, API_ORIGIN, apiUrl } from './devhub.ts'

const KEY = 'proofgate.auth'
/** Fired on window when the API rejects the token (expired / revoked) — the app returns to sign-in. */
export const AUTH_REQUIRED_EVENT = 'proofgate:auth-required'

type Stored = { token: string; exp: number }
let memory: Stored | null = null          // fallback when sessionStorage is unavailable

function storage(): Storage | null {
  try { return globalThis.sessionStorage ?? null } catch { return null }
}

/** Current token, or null if none / expired (`now` in seconds). */
export function getToken(now: number = Date.now() / 1000): string | null {
  let s: Stored | null = memory
  try {
    const raw = storage()?.getItem(KEY)
    if (raw) s = JSON.parse(raw) as Stored
  } catch { /* use memory */ }
  if (!s || typeof s.token !== 'string' || !(s.exp > now)) return null
  return s.token
}

export function setToken(token: string, exp: number): void {
  memory = { token, exp }
  try { storage()?.setItem(KEY, JSON.stringify(memory)) } catch { /* memory only */ }
}

export function clearToken(): void {
  memory = null
  try { storage()?.removeItem(KEY) } catch { /* ignore */ }
}

/** True for URLs that point at the ProofGate API — the token is never sent anywhere else. */
export function isApiUrl(url: string): boolean {
  if (url.startsWith('/')) return !url.startsWith('//')
  return [API_ORIGIN, API_BASE].some((o) => !!o && (url === o || url.startsWith(o + '/')))
}

/** fetch() for API paths ('/v1/…') or absolute API URLs, with the session token attached. */
export async function apiFetch(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : apiUrl(pathOrUrl)
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token && isApiUrl(url)) headers.set('Authorization', `Bearer ${token}`)
  const res = await fetch(url, { ...init, headers })
  if (res.status === 401 && !url.includes('/v1/auth/')) {
    clearToken()
    try { globalThis.dispatchEvent?.(new Event(AUTH_REQUIRED_EVENT)) } catch { /* non-browser */ }
  }
  return res
}

export type AuthStatus = { auth_required: boolean; configured: boolean }

/** GET /v1/auth/status — null if the backend is unreachable. */
export async function authStatus(): Promise<AuthStatus | null> {
  try {
    const r = await fetch(apiUrl('/v1/auth/status'))
    return r.ok ? ((await r.json()) as AuthStatus) : null
  } catch { return null }
}

export type LoginResult = { ok: true } | { ok: false; message: string }

/** POST /v1/auth/login with the demo password; stores the returned token. */
export async function login(password: string): Promise<LoginResult> {
  let r: Response
  try {
    r = await fetch(apiUrl('/v1/auth/login'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    })
  } catch {
    return { ok: false, message: 'The ProofGate backend could not be reached.' }
  }
  const j = await r.json().catch(() => ({})) as { token?: string; expires_at?: number; detail?: { message?: string } }
  if (r.ok && j.token && j.expires_at) {
    setToken(j.token, j.expires_at)
    return { ok: true }
  }
  return { ok: false, message: j.detail?.message || `Sign-in failed (HTTP ${r.status}).` }
}

/** POST /v1/auth/logout (revokes the token server-side), then forget it locally. */
export async function logout(): Promise<void> {
  const token = getToken()
  clearToken()
  if (!token) return
  try {
    await fetch(apiUrl('/v1/auth/logout'), { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  } catch { /* token is already gone locally; it also expires on its own */ }
}
