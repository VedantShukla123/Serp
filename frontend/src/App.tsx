import { useEffect, useState } from 'react'
import Assistant from './Assistant'
import { Forgot, SignIn, SignUp } from './Auth'
import ActionSimulator from './ActionSimulator'
import Developers from './Developers'
import Landing, { Logo } from './Landing'
import Playground from './Playground'
import { BookContext, type BookTarget } from './Trace'
import { useAgentChat } from './chat'
import { API_BASE, API_ORIGIN, apiUrl } from './devhub'
import { go, parseRoute, type Route } from './route'

type Health = { state: 'checking' | 'ready' | 'degraded' | 'offline'; detail: string }

/* ---------------- health (GET /health) ---------------- */
async function checkHealth(): Promise<Health> {
  const tries = API_ORIGIN ? [apiUrl('/health')] : ['/health', `${API_BASE}/health`]
  for (const url of tries) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 4000)
      const r = await fetch(url, { signal: ctl.signal })
      clearTimeout(t)
      if (!r.ok) continue
      const j = await r.json().catch(() => ({}))
      const missing: string[] = Array.isArray(j.missing_credentials) ? j.missing_credentials : []
      if (j.ready === false || missing.length > 0) return { state: 'degraded', detail: `missing ${missing.join(', ') || 'creds'}` }
      return { state: 'ready', detail: 'API ready' }
    } catch { /* try next */ }
  }
  return { state: 'offline', detail: 'backend unreachable' }
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const on = () => { setRoute(parseRoute(window.location.hash)); window.scrollTo(0, 0) }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

const NAV = [
  { tab: 'assistant', label: 'Assistant', icon: <path d="M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4v-4H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" /> },
  { tab: 'playground', label: 'Playground', icon: <><circle cx="5" cy="12" r="2.2" /><circle cx="12" cy="6" r="2.2" /><circle cx="19" cy="12" r="2.2" /><circle cx="12" cy="18" r="2.2" /><path d="M7 11l3-3.5M14 7.5l3 3.5M17 13l-3 3.5M10 16.5L7 13" /></> },
  { tab: 'developers', label: 'Developers', icon: <path d="M8.5 8L4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13" /> },
] as const

export default function App() {
  const route = useRoute()
  if (route.page === 'landing') return <Landing />
  if (route.page === 'signin') return <SignIn />
  if (route.page === 'signup') return <SignUp />
  if (route.page === 'forgot') return <Forgot />
  return <AppShell tab={route.tab} sub={route.sub} arg={route.arg} />
}

function AppShell({ tab, sub, arg }: { tab: 'assistant' | 'playground' | 'developers'; sub: string | null; arg: string | null }) {
  // Two independent conversations (own server sessions) that survive tab switches.
  const assistant = useAgentChat('proofgate.session_id')
  const playground = useAgentChat('proofgate.playground_session_id')
  const [bookTarget, setBookTarget] = useState<BookTarget | null>(null)
  const [health, setHealth] = useState<Health>({ state: 'checking', detail: 'checking…' })

  useEffect(() => {
    let live = true
    checkHealth().then((h) => { if (live) setHealth(h) })
    const t = setInterval(() => checkHealth().then((h) => { if (live) setHealth(h) }), 30000)
    return () => { live = false; clearInterval(t) }
  }, [])

  return (
    <BookContext.Provider value={setBookTarget}>
      <div className="shell">
        <header className="topbar">
          <Logo onClick={() => go('/')} />
          <nav className="appnav" aria-label="Primary">
            {NAV.map((n) => (
              <button key={n.tab} className={'appnav-btn' + (tab === n.tab ? ' on' : '')} aria-current={tab === n.tab ? 'page' : undefined}
                onClick={() => go(n.tab === 'assistant' ? '/app' : `/app/${n.tab}`)}>
                <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{n.icon}</svg>
                <span>{n.label}</span>
              </button>
            ))}
          </nav>
          <div className="topbar-right">
            <span className={`api-dot ${health.state}`} title={health.detail}>
              <i />{health.state === 'ready' ? 'API ready' : health.state === 'degraded' ? health.detail : health.state === 'checking' ? 'checking…' : 'backend offline'}
            </span>
            <span className="demo-pill" title="No authentication in this build">Demo workspace</span>
            <button className="btn ghost sm" onClick={() => go('/')}>Exit</button>
          </div>
        </header>
        <main className="shell-main" key={tab}>
          {tab === 'assistant' && <Assistant chat={assistant} />}
          {tab === 'playground' && <Playground chat={playground} />}
          {tab === 'developers' && <Developers sub={sub} arg={arg} />}
        </main>
      </div>
      {bookTarget && (
        <ActionSimulator key={bookTarget.runId + bookTarget.candidateId} runId={bookTarget.runId}
          candidateId={bookTarget.candidateId} onClose={() => setBookTarget(null)} />
      )}
    </BookContext.Provider>
  )
}
