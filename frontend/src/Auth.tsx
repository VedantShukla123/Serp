import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Logo } from './Landing'
import { go } from './route'
import { authStatus, getToken, login, register, takeExpiredNotice, takeNext, type AuthStatus } from './api'
import { PASSWORD_MAX, PASSWORD_MIN, validateSignIn, validateSignUp, type AuthErrors } from './authForms'

/* Account screens. Real accounts: POST /v1/auth/register and /v1/auth/login (app/api/auth_routes.py)
   return a short-lived signed session token for that user. The server validates everything again;
   the checks here only give instant feedback. Passwords are never stored in the browser. */

function Shell({ title, sub, children, foot }: { title: string; sub: string; children: ReactNode; foot: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-side">
        <Logo />
        <div className="auth-quote">
          <h2>Every action, <em>checked against the evidence.</em></h2>
          <ul className="auth-steps">
            <li><span className="vpill ok">SATISFIED</span> supported by evidence</li>
            <li><span className="vpill warn">UNKNOWN</span> sent to human review</li>
            <li><span className="vpill bad">CONTRADICTED</span> blocks the action</li>
          </ul>
        </div>
        <small>Your runs, bookings and orders are private to your account.</small>
      </aside>
      <main className="auth-main">
        <div className="auth-card enter">
          <h1>{title}</h1>
          <p className="muted">{sub}</p>
          {children}
          <div className="auth-foot">{foot}</div>
        </div>
      </main>
    </div>
  )
}

function Field({ label, error, children, hint }: { label: string; error?: string; children: ReactNode; hint?: string }) {
  return (
    <label className={'field' + (error ? ' invalid' : '')}>
      <span>{label}</span>
      {children}
      {error ? <em role="alert">{error}</em> : hint ? <small>{hint}</small> : null}
    </label>
  )
}

function Password({ value, onChange, autoComplete, label = 'Password', error, hint, name }: {
  value: string; onChange: (v: string) => void; autoComplete: string; label?: string; error?: string; hint?: string; name: string
}) {
  const [show, setShow] = useState(false)
  return (
    <Field label={label} error={error} hint={hint}>
      <div className="pw">
        <input type={show ? 'text' : 'password'} name={name} value={value} maxLength={PASSWORD_MAX + 1}
          onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} aria-invalid={!!error} />
        <button type="button" onClick={() => setShow(!show)} aria-label={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
      </div>
    </Field>
  )
}

function Notice({ title, children, tone = 'warn' }: { title: string; children?: ReactNode; tone?: 'warn' | 'info' }) {
  return (
    <div className={'demo-notice enter' + (tone === 'info' ? ' info' : '')} role="status">
      <b>{title}</b>
      {children}
    </div>
  )
}

/** Server state for the account screens: accounts on, local dev without accounts, misconfigured, offline. */
function useAccess(): AuthStatus | null | 'loading' {
  const [status, setStatus] = useState<AuthStatus | null | 'loading'>('loading')
  useEffect(() => {
    if (getToken()) { go(takeNext()); return }
    let live = true
    authStatus().then((s) => { if (live) setStatus(s) })
    return () => { live = false }
  }, [])
  return status
}

/** Explains states where the account form can't be used; null when the form should be shown. */
function accessNotice(status: AuthStatus | null | 'loading'): ReactNode | null {
  if (status === 'loading') return <p className="muted" role="status">Checking the server…</p>
  if (status === null) return (
    <Notice title="The ProofGate server could not be reached.">
      <p>Check your connection and reload this page.</p>
    </Notice>
  )
  if (!status.configured) return (
    <Notice title="Sign-in is not configured on this server.">
      <p>The server's session secret is missing or too short, so the API stays closed. The operator needs to set <code>PROOFGATE_SESSION_SECRET</code>.</p>
    </Notice>
  )
  if (!status.auth_required) return (
    <Notice title="Local development server — accounts are switched off." tone="info">
      <p>This server runs without <code>PROOFGATE_SESSION_SECRET</code>, so there is one local workspace and no sign-in. Deployed servers always require an account.</p>
      <button className="btn primary block" onClick={() => go('/app')}>Open the local workspace</button>
    </Notice>
  )
  return null
}

export function SignIn() {
  const status = useAccess()
  const [expired] = useState(() => takeExpiredNotice())
  const [f, setF] = useState({ email: '', password: '' })
  const [e, setE] = useState<AuthErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(ev: FormEvent) {
    ev.preventDefault()
    if (busy) return
    const errs = validateSignIn(f)
    setE(errs)
    setFormError(null)
    if (Object.keys(errs).length) return
    setBusy(true)
    const r = await login(f.email, f.password)
    setBusy(false)
    if (r.ok) { go(takeNext()); return }
    setF((x) => ({ ...x, password: '' }))          // never keep a rejected password around
    setE(r.errors)
    setFormError(r.message)
  }

  const blocked = accessNotice(status)
  return (
    <Shell title="Welcome back" sub="Sign in to your ProofGate account."
      foot={<>New to ProofGate? <button className="link" onClick={() => go('/signup')}>Create an account</button></>}>
      {expired && !blocked && <Notice title="Your session has ended.">
        <p>For your security, sessions expire. Please sign in again to continue where you left off.</p>
      </Notice>}
      {blocked ?? (
        <form onSubmit={submit} noValidate className="form" aria-busy={busy}>
          {formError && <p className="form-error" role="alert">{formError}</p>}
          <Field label="Email" error={e.email}>
            <input type="email" name="email" value={f.email} autoComplete="email" maxLength={254} aria-invalid={!!e.email}
              onChange={(x) => setF({ ...f, email: x.target.value })} />
          </Field>
          <Password name="password" value={f.password} onChange={(v) => setF({ ...f, password: v })}
            autoComplete="current-password" error={e.password} />
          <button className="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="muted sm center"><button type="button" className="link" onClick={() => go('/forgot')}>Forgot your password?</button></p>
        </form>
      )}
    </Shell>
  )
}

export function SignUp() {
  const status = useAccess()
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '' })
  const [e, setE] = useState<AuthErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [taken, setTaken] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit(ev: FormEvent) {
    ev.preventDefault()
    if (busy) return
    const errs = validateSignUp(f)
    setE(errs)
    setFormError(null)
    setTaken(false)
    if (Object.keys(errs).length) return
    setBusy(true)
    const r = await register(f.name, f.email, f.password)
    setBusy(false)
    if (r.ok) { go(takeNext()); return }
    setE(r.errors)
    setTaken(r.status === 409)
    setFormError(r.status === 409 ? null : r.message)
  }

  const blocked = accessNotice(status)
  return (
    <Shell title="Create your account" sub="Verification for every action your agents take."
      foot={<>Already have an account? <button className="link" onClick={() => go('/signin')}>Sign in</button></>}>
      {blocked ?? (
        <form onSubmit={submit} noValidate className="form" aria-busy={busy}>
          {formError && <p className="form-error" role="alert">{formError}</p>}
          <Field label="Name" error={e.name}>
            <input name="name" value={f.name} autoComplete="name" maxLength={100} aria-invalid={!!e.name}
              onChange={(x) => setF({ ...f, name: x.target.value })} />
          </Field>
          <Field label="Email" error={e.email}>
            <input type="email" name="email" value={f.email} autoComplete="email" maxLength={254} aria-invalid={!!e.email}
              onChange={(x) => { setF({ ...f, email: x.target.value }); setTaken(false) }} />
          </Field>
          {taken && <p className="sm taken" role="status">
            <button type="button" className="link" onClick={() => go('/signin')}>Sign in to that account instead →</button>
          </p>}
          <Password name="password" value={f.password} onChange={(v) => setF({ ...f, password: v })} autoComplete="new-password"
            error={e.password} hint={`${PASSWORD_MIN}–${PASSWORD_MAX} characters. A short phrase is easy to remember and hard to guess.`} />
          <Password name="confirm" label="Confirm password" value={f.confirm} onChange={(v) => setF({ ...f, confirm: v })}
            autoComplete="new-password" error={e.confirm} />
          <button className="btn primary block" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
        </form>
      )}
    </Shell>
  )
}

/** No email service is configured, so no reset link can be sent — this page says so plainly. */
export function Forgot() {
  return (
    <Shell title="Forgot your password?" sub="Here's what you can do."
      foot={<><button className="link" onClick={() => go('/signin')}>← Back to sign in</button></>}>
      <Notice title="Password reset by email isn't available yet.">
        <p>This ProofGate server has no email service configured, so it cannot send reset links — and it won't pretend to.
          Ask the person who runs this server for help, or create a new account.</p>
      </Notice>
      <button className="btn secondary block" onClick={() => go('/signup')}>Create a new account</button>
    </Shell>
  )
}
