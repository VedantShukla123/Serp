import { useState, type FormEvent, type ReactNode } from 'react'
import { Logo } from './Landing'
import { go } from './route'
import { validateForgot, validateSignIn, validateSignUp, type AuthErrors } from './authForms'

/* Access screens. This build has NO authentication backend: forms validate locally
   for feedback only. Credentials are never sent anywhere or stored, and no account
   is created. The honest path in is "demo access". */

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
          <div className="demo-banner">Demo access · account sign-in is coming soon</div>
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

function DemoNotice({ what }: { what: string }) {
  return (
    <div className="demo-notice enter" role="status">
      <b>{what}</b>
      <p>Authentication isn’t available in this demo build. Nothing was sent to a server or stored, and no account exists. You can continue into the demo workspace.</p>
      <button className="btn primary block" onClick={() => go('/app')}>Enter demo workspace</button>
    </div>
  )
}

function DemoButton() {
  return <button type="button" className="btn secondary block" onClick={() => go('/app')}>Continue with demo access</button>
}

export function SignIn() {
  const [f, setF] = useState({ email: '', password: '' })
  const [e, setE] = useState<AuthErrors>({})
  const [done, setDone] = useState(false)
  function submit(ev: FormEvent) {
    ev.preventDefault()
    const errs = validateSignIn(f)
    setE(errs)
    if (Object.keys(errs).length) return
    setF({ ...f, password: '' })   // never keep the password around
    setDone(true)
  }
  return (
    <Shell title="Welcome back" sub="Sign in to your ProofGate workspace."
      foot={<>New here? <button className="link" onClick={() => go('/signup')}>Create an account</button></>}>
      {done ? <DemoNotice what="Signed in? Not quite." /> : (
        <form onSubmit={submit} noValidate className="form">
          <DemoButton />
          <div className="or"><span>or sign in with email</span></div>
          <Field label="Email" error={e.email}><input type="email" value={f.email} onChange={(x) => setF({ ...f, email: x.target.value })} autoComplete="email" /></Field>
          <Password value={f.password} onChange={(v) => setF({ ...f, password: v })} autoComplete="current-password" error={e.password} />
          <div className="row-end"><button type="button" className="link" onClick={() => go('/forgot')}>Forgot password?</button></div>
          <button className="btn primary block">Sign in</button>
        </form>
      )}
    </Shell>
  )
}

export function SignUp() {
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '', terms: false })
  const [e, setE] = useState<AuthErrors>({})
  const [done, setDone] = useState(false)
  function submit(ev: FormEvent) {
    ev.preventDefault()
    const errs = validateSignUp(f)
    setE(errs)
    if (Object.keys(errs).length) return
    setF({ ...f, password: '', confirm: '' })
    setDone(true)
  }
  return (
    <Shell title="Create your workspace" sub="Verification for every action your agents take."
      foot={<>Already have access? <button className="link" onClick={() => go('/signin')}>Sign in</button></>}>
      {done ? <DemoNotice what="No account was created." /> : (
        <form onSubmit={submit} noValidate className="form">
          <DemoButton />
          <div className="or"><span>or sign up with email</span></div>
          <Field label="Name" error={e.name}><input value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} autoComplete="name" /></Field>
          <Field label="Work email" error={e.email}><input type="email" value={f.email} onChange={(x) => setF({ ...f, email: x.target.value })} autoComplete="email" /></Field>
          <Password value={f.password} onChange={(v) => setF({ ...f, password: v })} autoComplete="new-password" error={e.password} hint="At least 8 characters, with letters and a number." />
          <Password label="Confirm password" value={f.confirm} onChange={(v) => setF({ ...f, confirm: v })} autoComplete="new-password" error={e.confirm} />
          <label className={'check' + (e.terms ? ' invalid' : '')}>
            <input type="checkbox" checked={f.terms} onChange={(x) => setF({ ...f, terms: x.target.checked })} />
            <span>I understand this is a demo workspace and no account will be created.</span>
          </label>
          {e.terms && <em className="err-text sm">{e.terms}</em>}
          <button className="btn primary block">Create account</button>
        </form>
      )}
    </Shell>
  )
}

export function Forgot() {
  const [email, setEmail] = useState('')
  const [e, setE] = useState<AuthErrors>({})
  const [done, setDone] = useState(false)
  return (
    <Shell title="Reset your password" sub="We’ll explain what happens in this demo build."
      foot={<><button className="link" onClick={() => go('/signin')}>← Back to sign in</button></>}>
      {done ? (
        <div className="demo-notice enter" role="status">
          <b>No email was sent.</b>
          <p>Password reset needs real accounts, which this demo build doesn’t have. Use demo access instead.</p>
          <button className="btn primary block" onClick={() => go('/app')}>Enter demo workspace</button>
        </div>
      ) : (
        <form className="form" noValidate onSubmit={(ev) => { ev.preventDefault(); const errs = validateForgot({ email }); setE(errs); if (!Object.keys(errs).length) setDone(true) }}>
          <Field label="Email" error={e.email}><input type="email" value={email} onChange={(x) => setEmail(x.target.value)} autoComplete="email" /></Field>
          <button className="btn primary block">Send reset link</button>
        </form>
      )}
    </Shell>
  )
}
