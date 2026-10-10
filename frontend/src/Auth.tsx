import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Logo } from './Landing'
import { go } from './route'
import { authStatus, getToken, login, type AuthStatus } from './api'

/* Access screens. ProofGate has NO user accounts: a deployed demo is protected by one shared
   demo password, checked by the server (POST /v1/auth/login), which returns a short-lived
   signed session token. Sign-up and password reset therefore only explain this. */

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
        <small>ProofGate · demo workspace</small>
      </aside>
      <main className="auth-main">
        <div className="auth-card enter">
          <div className="demo-banner">Demo access · one shared demo password, no personal accounts</div>
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

function Password({ value, onChange, autoComplete, label = 'Password', error, hint }: { value: string; onChange: (v: string) => void; autoComplete: string; label?: string; error?: string; hint?: string }) {
  const [show, setShow] = useState(false)
  return (
    <Field label={label} error={error} hint={hint}>
      <div className="pw">
        <input type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} />
        <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}>{show ? 'Hide' : 'Show'}</button>
      </div>
    </Field>
  )
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="demo-notice enter" role="status">
      <b>{title}</b>
      {children}
    </div>
  )
}

export function SignIn() {
  const [status, setStatus] = useState<AuthStatus | null | 'loading'>('loading')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (getToken()) { go('/app'); return }
    let live = true
    authStatus().then((s) => { if (live) setStatus(s) })
    return () => { live = false }
  }, [])

  async function submit(ev: FormEvent) {
    ev.preventDefault()
    if (!password) { setError('Enter the demo password.'); return }
    setBusy(true)
    const r = await login(password)
    setPassword('')                     // never keep the password around
    setBusy(false)
    if (r.ok) go('/app')
    else setError(r.message)
  }

  let body: ReactNode
  if (status === 'loading') body = <p className="muted" role="status">Checking access…</p>
  else if (status === null) body = (
    <Notice title="The ProofGate backend could not be reached.">
      <p>Start it (locally: <code>python run.py --serve</code>) and reload this page.</p>
    </Notice>
  )
  else if (!status.configured) body = (
    <Notice title="Access is not configured on this server.">
      <p>The server requires sign-in but its demo password or session secret is missing or too short, so the API stays closed. The operator needs to set them in the hosting dashboard.</p>
    </Notice>
  )
  else if (!status.auth_required) body = (
    <Notice title="This server does not require sign-in.">
      <p>It is running in local development mode. No password is needed.</p>
      <button className="btn primary block" onClick={() => go('/app')}>Enter demo workspace</button>
    </Notice>
  )
  else body = (
    <form onSubmit={submit} noValidate className="form">
      <Password label="Demo password" value={password} onChange={(v) => { setPassword(v); setError(undefined) }} autoComplete="current-password" error={error}
        hint="Ask the person who shared this demo. Your session lasts a limited time." />
      <button className="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Enter demo workspace'}</button>
    </form>
  )

  return (
    <Shell title="Sign in to the demo" sub="This ProofGate demo is protected by a shared password."
      foot={<>No password? <button className="link" onClick={() => go('/signup')}>How access works</button></>}>
      {body}
    </Shell>
  )
}

export function SignUp() {
  return (
    <Shell title="Access to this demo" sub="There is nothing to sign up for."
      foot={<>Have the password? <button className="link" onClick={() => go('/signin')}>Sign in</button></>}>
      <Notice title="ProofGate has no user accounts.">
        <p>This demo is protected by a single shared demo password set by whoever runs it. Ask them for it, then sign in. No account is created and no personal data is collected.</p>
        <button className="btn primary block" onClick={() => go('/signin')}>Go to sign in</button>
      </Notice>
    </Shell>
  )
}

export function Forgot() {
  return (
    <Shell title="Forgot the password?" sub="There is no account to recover."
      foot={<><button className="link" onClick={() => go('/signin')}>← Back to sign in</button></>}>
      <Notice title="No reset email can be sent.">
        <p>The demo password is shared, not personal. Ask the person who runs this demo for it.</p>
        <button className="btn primary block" onClick={() => go('/signin')}>Back to sign in</button>
      </Notice>
    </Shell>
  )
}
