/* The one place the browser talks to the ProofGate API (no React) — unit-tested.
   Attaches the signed-in account's bearer token to every API request (JSON, streaming SSE,
   simulated actions, Developer tools). The token is a short-lived server-signed value kept in
   sessionStorage with the public profile (cleared when the tab closes) — never in a VITE_ variable,
   and the password is never stored. */
import { API_BASE, API_ORIGIN, apiUrl } from './devhub.ts'

const KEY = 'proofgate.auth'
const EXPIRED_KEY = 'proofgate.session_expired'
const NEXT_KEY = 'proofgate.next'
/** Fired on window when the API rejects the token (expired / revoked) — the app returns to sign-in. */
export const AUTH_REQUIRED_EVENT = 'proofgate:auth-required'

export type User = { user_id: string; name: string; email: string; created_at?: string }
type Stored = { token: string; exp: number; user?: User | null }
let memory: Stored | null = null          // fallback when sessionStorage is unavailable

function storage(): Storage | null {
  try { return globalThis.sessionStorage ?? null } catch { return null }
}

function read(): Stored | null {
  let s: Stored | null = memory
  try {
    const raw = storage()?.getItem(KEY)
    if (raw) s = JSON.parse(raw) as Stored
  } catch { /* use memory */ }
  return s && typeof s.token === 'string' ? s : null
}

/** Current token, or null if none / expired (`now` in seconds). A token that ran out is cleared
    and remembered so the sign-in screen can say the session expired. */
export function getToken(now: number = Date.now() / 1000): string | null {
  const s = read()
  if (!s) return null
  if (!(s.exp > now)) { endSession('expired'); return null }
  return s.token
}

/** The signed-in account's public profile (no secrets), or null. */
export function getUser(now: number = Date.now() / 1000): User | null {
  return getToken(now) ? read()?.user ?? null : null
}

export function setSession(token: string, exp: number, user: User | null = null): void {
  memory = { token, exp, user }
  try { storage()?.setItem(KEY, JSON.stringify(memory)); storage()?.removeItem(EXPIRED_KEY) } catch { /* memory only */ }
}

/** Backwards-compatible alias. */
export const setToken = (token: string, exp: number) => setSession(token, exp)

export function clearToken(): void {
  memory = null
  try { storage()?.removeItem(KEY) } catch { /* ignore */ }
}

let expiredFlag = false
function endSession(reason: 'expired' | 'signed_out'): void {
  clearToken()
  expiredFlag = reason === 'expired'
  try {
    if (reason === 'expired') storage()?.setItem(EXPIRED_KEY, '1')
    else storage()?.removeItem(EXPIRED_KEY)
  } catch { /* memory flag only */ }
}

/** True once after a session expired or was rejected (read by the sign-in screen, then cleared). */
export function takeExpiredNotice(): boolean {
  let flagged = expiredFlag
  try { flagged = flagged || storage()?.getItem(EXPIRED_KEY) === '1'; storage()?.removeItem(EXPIRED_KEY) } catch { /* ignore */ }
  expiredFlag = false
  return flagged
}

/** Where to go after signing in: the app screen the visitor was sent away from (hash routes only). */
export function rememberNext(route: string): void {
  if (!route.startsWith('/app')) return
  try { storage()?.setItem(NEXT_KEY, route) } catch { /* ignore */ }
}
export function takeNext(): string {
  let next = '/app'
  try { next = storage()?.getItem(NEXT_KEY) || '/app'; storage()?.removeItem(NEXT_KEY) } catch { /* ignore */ }
  return next.startsWith('/app') ? next : '/app'
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
  if (res.status === 401 && !url.includes('/v1/auth/login') && !url.includes('/v1/auth/register')) {
    // A request sent without a token (e.g. right after the token ran out) must not erase the
    // "session expired" notice that getToken() just recorded.
    if (token) endSession('expired')
    else clearToken()
    try { globalThis.dispatchEvent?.(new Event(AUTH_REQUIRED_EVENT)) } catch { /* non-browser */ }
  }
  return res
}

export type AuthStatus = { auth_required: boolean; configured: boolean; accounts?: boolean }

/** GET /v1/auth/status — null if the backend is unreachable. */
export async function authStatus(): Promise<AuthStatus | null> {
  try {
    const r = await fetch(apiUrl('/v1/auth/status'))
    return r.ok ? ((await r.json()) as AuthStatus) : null
  } catch { return null }
}

export type FieldErrors = Partial<Record<'name' | 'email' | 'password' | 'confirm', string>>
export type AuthResult = { ok: true; user: User } | { ok: false; status: number; message: string; errors: FieldErrors }

type ApiDetail = { code?: string; message?: string; errors?: Record<string, string> }

/** Turns any auth response into a result the forms can show (field errors + one message). */
export async function toAuthResult(r: Response): Promise<AuthResult> {
  const j = await r.json().catch(() => ({})) as { token?: string; expires_at?: number; user?: User; detail?: ApiDetail | unknown[] }
  if (r.ok && j.token && j.expires_at && j.user) {
    setSession(j.token, j.expires_at, j.user)
    return { ok: true, user: j.user }
  }
  const d = (j.detail && !Array.isArray(j.detail) ? j.detail : {}) as ApiDetail
  const errors: FieldErrors = {}
  for (const k of ['name', 'email', 'password'] as const) if (d.errors?.[k]) errors[k] = d.errors[k]
  const message = d.message
    || (r.status === 422 ? 'Please check the highlighted fields.'
      : r.status === 429 ? 'Too many attempts. Please wait and try again.'
        : r.status >= 500 ? 'ProofGate is unavailable right now. Please try again shortly.'
          : `Request failed (HTTP ${r.status}).`)
  return { ok: false, status: r.status, message, errors }
}

async function postAuth(path: string, body: Record<string, string>): Promise<AuthResult> {
  let r: Response
  try {
    r = await fetch(apiUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    return { ok: false, status: 0, message: 'The ProofGate server could not be reached. Check your connection and try again.', errors: {} }
  }
  return toAuthResult(r)
}

/** POST /v1/auth/login with email + password; stores the token and profile on success. */
export function login(email: string, password: string): Promise<AuthResult> {
  return postAuth('/v1/auth/login', { email: email.trim(), password })
}

/** POST /v1/auth/register; on success the new account is signed in. */
export function register(name: string, email: string, password: string): Promise<AuthResult> {
  return postAuth('/v1/auth/register', { name: name.trim(), email: email.trim(), password })
}

/** GET /v1/auth/me — refreshes the stored profile; null if not signed in (a 401 ends the session). */
export async function me(): Promise<User | null> {
  const s = read()
  if (!getToken()) return null
  try {
    const r = await apiFetch('/v1/auth/me')
    if (!r.ok) return null
    const user = await r.json() as User
    if (s) setSession(s.token, s.exp, user)
    return user
  } catch { return null }
}

/** POST /v1/auth/logout (revokes the token server-side), then forget it locally. */
export async function logout(): Promise<void> {
  const token = read()?.token ?? null
  endSession('signed_out')
  if (!token) return
  try {
    await fetch(apiUrl('/v1/auth/logout'), { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  } catch { /* token is already gone locally; it also expires on its own */ }
}
