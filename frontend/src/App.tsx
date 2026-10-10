import { useCallback, useEffect, useRef, useState } from 'react'
import roboUrl from './assets/robo.png'
import RoboViewer from './RoboViewer'
import { isCandidateVerdict, normReq, rankedFromEvent, rankReasonFor, verdictForCandidate, type RankedItem, type ReqItem } from './traceEvents'

/* ------------------------------------------------------------------ */
/* Contract types (POST /v1/agent/chat + SSE /v1/agent/chat/stream)    */
/* Backend is concurrently adding these; UI develops against contract */
/* ------------------------------------------------------------------ */

type CandItem = {
  candidate_id?: string; id?: string
  name?: string; candidate_name?: string; title?: string
  price?: string | number | null
  rating?: string | number | null
  source_url?: string; url?: string; link?: string
  [k: string]: unknown
}
type VerdictReq = { requirement?: string; requirement_id?: string; id?: string; status: string; reason?: string }
type VerdictBlock = { candidate_id: string; candidate_name?: string; overall_status: string; requirements: VerdictReq[] }

type TraceState = {
  open: boolean
  statusLine: string
  routeNote: string | null
  requirements: ReqItem[]
  engine: string | null
  candidateCount: number | null
  candidates: CandItem[]
  ranked: RankedItem[]
  verifying: { candidate_id: string; candidate_name: string; attempt: number; of: number } | null
  verdicts: VerdictBlock[]
  rejectedIds: string[]
  final: {
    status: string
    selected_candidate: CandItem | null
    verification: { overall_status: string; requirements: VerdictReq[] } | null
    run_id: string | null
  } | null
  error: string | null
}

type ChatMsg = {
  id: string
  role: 'user' | 'agent'
  text: string
  live: boolean
  trace?: TraceState
  runId?: string | null
  notice?: string | null
}

type Health = { state: 'checking' | 'ready' | 'degraded' | 'offline'; detail: string }

const SESSION_KEY = 'proofgate.session_id'
const EXAMPLES = [
  'Hotel in Goa under Rs 10,000, beachfront, breakfast + free cancellation',
  'Laptop under Rs 90,000, 32GB RAM, OLED display',
  'What can you verify for me?',
]

function emptyTrace(): TraceState {
  return {
    open: true, statusLine: 'Understanding…', routeNote: null,
    requirements: [], engine: null, candidateCount: null, candidates: [],
    ranked: [], verifying: null, verdicts: [], rejectedIds: [], final: null, error: null,
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

function loadSession(): string | null {
  try { return localStorage.getItem(SESSION_KEY) } catch { return null }
}
function saveSession(id: string) {
  try { localStorage.setItem(SESSION_KEY, id) } catch { /* ignore */ }
}

function candId(c: CandItem): string {
  return String(c.candidate_id ?? c.id ?? c.name ?? c.title ?? 'candidate')
}
function candName(c: CandItem): string {
  return String(c.candidate_name ?? c.name ?? c.title ?? candId(c))
}
function candUrl(c: CandItem): string | null {
  const u = c.source_url ?? c.url ?? c.link
  return typeof u === 'string' && u ? u : null
}
function fmtVal(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null
  return String(v)
}

function verdictClass(s: string): 'ok' | 'bad' | 'warn' {
  const t = s.toUpperCase()
  if (t === 'SATISFIED' || t === 'VERIFIED') return 'ok'
  if (t === 'CONTRADICTED' || t === 'REJECTED') return 'bad'
  return 'warn'
}

/* ---------------- health (spec: fetch /health) ---------------- */
async function checkHealth(): Promise<Health> {
  const tries = ['/health', 'http://localhost:8000/health']
  for (const url of tries) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 4000)
      const r = await fetch(url, { signal: ctl.signal })
      clearTimeout(t)
      if (!r.ok) continue
      const j = await r.json().catch(() => ({}))
      const missing: string[] = Array.isArray(j.missing_credentials) ? j.missing_credentials : []
      if (j.ready === false || missing.length > 0) {
        return { state: 'degraded', detail: `missing ${missing.join(', ') || 'creds'}` }
      }
      return { state: 'ready', detail: 'API ready' }
    } catch { /* try next */ }
  }
  return { state: 'offline', detail: 'backend unreachable' }
}

/* ---------------- SSE stream parsing ---------------- */
type StreamHandlers = {
  onEvent: (type: string, payload: Record<string, unknown>) => void
}

async function streamAgentChat(message: string, sessionId: string | null, h: StreamHandlers, signal: AbortSignal): Promise<void> {
  const qs = new URLSearchParams({ message })
  if (sessionId) qs.set('session_id', sessionId)
  const res = await fetch(`/v1/agent/chat/stream?${qs.toString()}`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`stream_unavailable: HTTP ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of chunk.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const raw = t.slice(5).trim()
        if (!raw || raw === '[DONE]') continue
        try {
          const evt = JSON.parse(raw) as { type?: string } & Record<string, unknown>
          h.onEvent(String(evt.type || 'status'), evt)
        } catch { /* ignore malformed line */ }
      }
    }
    if (signal.aborted) break
  }
}

/* ================================================================== */
export default function App() {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [health, setHealth] = useState<Health>({ state: 'checking', detail: 'checking…' })
  const [rail, setRail] = useState<'chat' | 'runs' | 'info'>('chat')
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const sessionRef = useRef<string | null>(loadSession())

  useEffect(() => {
    let live = true
    checkHealth().then((h) => { if (live) setHealth(h) })
    const t = setInterval(() => checkHealth().then((h) => { if (live) setHealth(h) }), 30000)
    return () => { live = false; clearInterval(t) }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  const patchTrace = useCallback((msgId: string, fn: (t: TraceState) => TraceState) => {
    setMessages((prev) => prev.map((m) => (m.id === msgId && m.trace ? { ...m, trace: fn(m.trace) } : m)))
  }, [])

  const setAgentText = useCallback((msgId: string, text: string, extra?: Partial<ChatMsg>) => {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, text, ...extra } : m)))
  }, [])

  function applyStreamEvent(msgId: string, type: string, p: Record<string, unknown>) {
    const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
    switch (type) {
      case 'status':
        patchTrace(msgId, (t) => ({ ...t, statusLine: str(p.message || p.stage) || t.statusLine, routeNote: str(p.stage) || t.routeNote }))
        break
      case 'requirements': {
        const arr = Array.isArray(p.requirements) ? p.requirements : []
        patchTrace(msgId, (t) => ({ ...t, requirements: arr.map(normReq), statusLine: 'Searching live…' }))
        break
      }
      case 'searching':
        patchTrace(msgId, (t) => ({ ...t, engine: str(p.engine) || 'serpapi', statusLine: `Searching live via SerpApi (${str(p.engine) || 'shopping'})…` }))
        break
      case 'candidates': {
        const arr = Array.isArray(p.candidates) ? (p.candidates as CandItem[]) : []
        const count = typeof p.count === 'number' ? p.count : arr.length
        patchTrace(msgId, (t) => ({ ...t, candidates: arr, candidateCount: count, statusLine: 'Ranking candidates…' }))
        break
      }
      case 'ranking':
        patchTrace(msgId, (t) => {
          const arr = rankedFromEvent(p, t.candidates)
          return { ...t, ranked: arr, statusLine: arr.length ? 'Verifying candidates…' : t.statusLine }
        })
        break
      case 'verifying':
        patchTrace(msgId, (t) => ({
          ...t,
          verifying: {
            candidate_id: str(p.candidate_id), candidate_name: str(p.candidate_name || p.candidate_id),
            attempt: Number(p.attempt) || 1, of: Number(p.of) || 1,
          },
          statusLine: `Verifying candidate ${Number(p.attempt) || 1}/${Number(p.of) || 1}…`,
        }))
        break
      case 'verdict': {
        // Run-level verdict (no candidate_id) — the `final` event renders the decision.
        if (!isCandidateVerdict(p)) break
        const vb: VerdictBlock = {
          candidate_id: str(p.candidate_id), candidate_name: str(p.candidate_name || p.candidate_id),
          overall_status: str(p.overall_status || 'UNKNOWN'),
          requirements: Array.isArray(p.requirements) ? (p.requirements as VerdictReq[]) : [],
        }
        patchTrace(msgId, (t) => {
          const rejected = vb.overall_status.toUpperCase() === 'REJECTED' || vb.overall_status.toUpperCase() === 'CONTRADICTED'
            ? [...t.rejectedIds, vb.candidate_id] : t.rejectedIds
          return { ...t, verdicts: [...t.verdicts, vb], rejectedIds: rejected, verifying: null }
        })
        break
      }
      case 'final': {
        const sel = (p.selected_candidate ?? null) as CandItem | null
        const ver = (p.verification ?? null) as TraceState['final'] extends { verification: infer V } ? V : never
        patchTrace(msgId, (t) => ({
          ...t, verifying: null, statusLine: '',
          final: { status: str(p.status || 'done'), selected_candidate: sel, verification: ver, run_id: str(p.run_id) || null },
        }))
        const reply = str(p.reply)
        setAgentText(msgId, reply || 'Done — see the verification trace below.', {
          live: false,
          runId: str(p.run_id) || null,
        })
        break
      }
      case 'error':
        patchTrace(msgId, (t) => ({ ...t, error: str(p.message) || 'stream error', statusLine: '' }))
        setAgentText(msgId, 'Something failed mid-verification — the trace below shows how far it got.', { live: false })
        break
      default:
        if (p.message) patchTrace(msgId, (t) => ({ ...t, statusLine: str(p.message) } as TraceState))
        break
    }
  }

  /** Fallback: full-JSON POST, then animate the trace reveal section by section. */
  async function runPostFallback(msgId: string, message: string) {
    const body: Record<string, string> = { message }
    if (sessionRef.current) body.session_id = sessionRef.current
    const res = await fetch('/v1/agent/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: abortRef.current?.signal,
    })
    if (!res.ok) throw new Error(`agent_chat_unavailable: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`)
    const j = await res.json()
    if (j.session_id) { sessionRef.current = String(j.session_id); saveSession(String(j.session_id)) }

    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const reqs: ReqItem[] = Array.isArray(j.requirements) ? j.requirements.map(normReq) : []
    const attempts: VerdictBlock[] = Array.isArray(j.attempts)
      ? j.attempts.map((a: Record<string, unknown>) => ({
          candidate_id: String(a.candidate_id ?? a.id ?? ''),
          candidate_name: String(a.candidate_name ?? a.name ?? a.candidate_id ?? ''),
          overall_status: String((a.verification as Record<string, unknown> | undefined)?.overall_status ?? a.overall_status ?? 'UNKNOWN'),
          requirements: (Array.isArray((a.verification as Record<string, unknown> | undefined)?.requirements)
            ? ((a.verification as Record<string, unknown>).requirements as VerdictReq[])
            : Array.isArray(a.requirements) ? (a.requirements as VerdictReq[]) : []),
        }))
      : []
    const cands: CandItem[] = Array.isArray(j.candidates) ? j.candidates : []
    const ranked: RankedItem[] = Array.isArray(j.ranked) ? j.ranked : []

    patchTrace(msgId, (t) => ({ ...t, statusLine: 'Understanding…' })); await wait(350)
    if (reqs.length) patchTrace(msgId, (t) => ({ ...t, requirements: reqs, statusLine: 'Searching live…' })); await wait(350)
    if (cands.length || typeof j.candidate_count === 'number')
      patchTrace(msgId, (t) => ({ ...t, candidates: cands, candidateCount: typeof j.candidate_count === 'number' ? j.candidate_count : cands.length, engine: typeof j.engine === 'string' ? j.engine : t.engine, statusLine: 'Ranking candidates…' }))
    await wait(350)
    if (ranked.length) patchTrace(msgId, (t) => ({ ...t, ranked, statusLine: 'Verifying candidates…' })); await wait(350)
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]
      patchTrace(msgId, (t) => ({ ...t, verifying: { candidate_id: a.candidate_id, candidate_name: a.candidate_name || a.candidate_id, attempt: i + 1, of: attempts.length }, statusLine: `Verifying candidate ${i + 1}/${attempts.length}…` }))
      await wait(400)
      patchTrace(msgId, (t) => ({
        ...t, verdicts: [...t.verdicts, a], verifying: null,
        rejectedIds: ['REJECTED', 'CONTRADICTED'].includes(a.overall_status.toUpperCase()) ? [...t.rejectedIds, a.candidate_id] : t.rejectedIds,
      }))
    }
    const sel = (j.selected_candidate ?? null) as CandItem | null
    patchTrace(msgId, (t) => ({
      ...t, statusLine: '',
      final: { status: String(j.status || 'done'), selected_candidate: sel, verification: (j.verification ?? null) as TraceState['final'] extends { verification: infer V } ? V : never, run_id: j.run_id ? String(j.run_id) : null },
    }))
    setAgentText(msgId, String(j.reply || 'Done — see the verification trace below.'), { live: false, runId: j.run_id ? String(j.run_id) : null })
  }

  async function send(raw?: string) {
    const text = (raw ?? input).trim()
    if (!text || sending) return
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    const msgId = uid()
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: 'user', text, live: false },
      { id: msgId, role: 'agent', text: '', live: true, trace: emptyTrace() },
    ])
    setInput('')
    setSending(true)
    const signal = abortRef.current.signal

    // Prefer SSE stream for progressive trace; fall back to full-JSON POST.
    try {
      await streamAgentChat(text, sessionRef.current, {
        onEvent: (type, payload) => {
          if (payload.session_id) { sessionRef.current = String(payload.session_id); saveSession(String(payload.session_id)) }
          if (type === 'final' && payload.session_id) { sessionRef.current = String(payload.session_id); saveSession(String(payload.session_id)) }
          applyStreamEvent(msgId, type, payload)
        },
      }, signal)
      // If stream ended with no final + no text, fall back to POST.
      let needsFallback = false
      setMessages((prev) => {
        const m = prev.find((x) => x.id === msgId)
        needsFallback = !!m && m.live && !m.trace?.final && !m.trace?.error
        return prev
      })
      if (needsFallback) await runPostFallback(msgId, text)
    } catch (e) {
      if (signal.aborted) { setSending(false); return }
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.startsWith('stream_unavailable') || msg.includes('Failed to fetch') || msg.includes('404') || msg.includes('405')) {
        try {
          await runPostFallback(msgId, text)
        } catch (e2) {
          const msg2 = e2 instanceof Error ? e2.message : String(e2)
          patchTrace(msgId, (t) => ({ ...t, statusLine: '', error: msg2 }))
          setAgentText(
            msgId,
            'The agent endpoint isn’t live on the backend yet — this UI is contract-ready and will light up as soon as POST /v1/agent/chat (or its SSE stream) responds.',
            { live: false, notice: 'Backend routes pending: POST /v1/agent/chat + GET /v1/agent/chat/stream (developing against the contract).' },
          )
        }
      } else {
        patchTrace(msgId, (t) => ({ ...t, statusLine: '', error: msg }))
        setAgentText(msgId, 'Something failed mid-verification — the trace below shows how far it got.', { live: false })
      }
    } finally {
      setSending(false)
    }
  }

  const empty = messages.length === 0

  return (
    <div className="pg-app">
      {/* ---------- left rail ---------- */}
      <nav className="pg-rail" aria-label="Primary">
        <div className="rail-logo"><img src={roboUrl} alt="ProofGate" /></div>
        <button className={'rail-btn' + (rail === 'chat' ? ' active' : '')} onClick={() => setRail('chat')} title="Chat" aria-label="Chat">
          <svg viewBox="0 0 24 24"><path d="M4 5.5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-5 4v-4H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><circle cx="8.5" cy="11" r="1.2" fill="currentColor" /><circle cx="12" cy="11" r="1.2" fill="currentColor" /><circle cx="15.5" cy="11" r="1.2" fill="currentColor" /></svg>
        </button>
        <button className={'rail-btn' + (rail === 'runs' ? ' active' : '')} onClick={() => setRail('runs')} title="Runs" aria-label="Runs">
          <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        </button>
        <button className={'rail-btn' + (rail === 'info' ? ' active' : '')} onClick={() => setRail('info')} title="About" aria-label="About">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M12 11v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="12" cy="8" r="1.2" fill="currentColor" /></svg>
        </button>
      </nav>

      {/* ---------- main column ---------- */}
      <div className="pg-main">
        <header className="pg-header">
          <div className="brand">
            <img className="brand-avatar" src={roboUrl} alt="ProofGate agent" />
            <div>
              <div className="wordmark">ProofGate</div>
              <div className="tagline">Search finds candidates. ProofGate finds the one that actually fits.</div>
            </div>
          </div>
          <div className="header-right">
            <span className={`api-dot ${health.state}`} title={health.detail}>
              <i />{health.state === 'ready' ? 'API ready' : health.state === 'degraded' ? health.detail : health.state === 'checking' ? 'checking…' : 'backend offline'}
            </span>
            <span className="engine-label">SerpApi live · Jev verify</span>
          </div>
        </header>

        {rail === 'chat' && (
          <div className="pg-scroll" ref={scrollRef}>
            <div className="pg-canvas">
              {empty && (
                <section className="hero">
                  <div className="hero-glow" />
                  <div className="hero-3d-canvas">
                    <RoboViewer />
                  </div>
                  <h1>Ask anything that needs a <em>verified</em> answer.</h1>
                  <p>ProofGate searches live, ranks candidates, then proves each hard requirement — showing its work.</p>
                </section>
              )}

              {messages.map((m) =>
                m.role === 'user' ? (
                  <div className="row user-row" key={m.id}>
                    <div className="bubble user">{m.text}</div>
                  </div>
                ) : (
                  <div className="row agent-row" key={m.id}>
                    <img className="avatar" src={roboUrl} alt="agent" />
                    <div className="bubble agent">
                      {m.live && !m.text ? (
                        <span className="typing"><i /><i /><i /></span>
                      ) : (
                        <p className="reply">{m.text}</p>
                      )}
                      {m.live && m.trace?.statusLine && (
                        <div className="stage-line"><span className="spinner" />{m.trace.statusLine}</div>
                      )}
                      {m.trace && <TraceView trace={m.trace} msgId={m.id} patchTrace={patchTrace} />}
                      {m.notice && <div className="contract-note">{m.notice}</div>}
                    </div>
                  </div>
                ),
              )}
              <div style={{ height: 8 }} />
            </div>
          </div>
        )}

        {rail === 'runs' && (
          <div className="pg-scroll"><div className="pg-canvas">
            <div className="bubble agent static">
              <h3>Run history</h3>
              <p>Run history lives server-side. Query <code>GET /v1/runs</code> or open <code>GET /v1/runs/{'{run_id}'}/evidence</code> for full candidates + raw SerpApi payloads.</p>
              {messages.filter((m) => m.runId).length === 0
                ? <p className="muted">No runs in this session yet — send a chat to create one.</p>
                : <ul className="run-list">{messages.filter((m) => m.runId).map((m) => <li key={m.id}><code>{m.runId}</code> — {m.text.slice(0, 80)}</li>)}</ul>}
            </div>
          </div></div>
        )}

        {rail === 'info' && (
          <div className="pg-scroll"><div className="pg-canvas">
            <div className="bubble agent static">
              <h3>How ProofGate verifies</h3>
              <p>1 · Parse hard requirements → 2 · Search SerpApi live → 3 · LLM-rank candidates → 4 · Jev-verify each requirement (SATISFIED / CONTRADICTED / UNKNOWN) → 5 · VERIFIED or NEEDS REVIEW. Rejected candidates stay visible — never hidden.</p>
              <p className="muted">All product logic is server-side; this UI is purely presentational.</p>
            </div>
          </div></div>
        )}

        {rail === 'chat' && (
          <footer className="pg-dock">
            {empty && (
              <div className="chips">
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="chip" onClick={() => send(ex)}>{ex}</button>
                ))}
              </div>
            )}
            <div className="input-pill">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
                placeholder="Ask anything that needs a verified answer…"
                aria-label="Ask ProofGate"
              />
              <button className="send" onClick={() => send()} disabled={sending || !input.trim()} aria-label="Send">
                <svg viewBox="0 0 24 24"><path d="M12 19V5m0 0l-6 6m6-6l6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </div>
          </footer>
        )}
      </div>
    </div>
  )
}

/* ================= trace timeline (the star) ================= */
function TraceView({ trace, msgId, patchTrace }: {
  trace: TraceState
  msgId: string
  patchTrace: (msgId: string, fn: (t: TraceState) => TraceState) => void
}) {
  const hasAnything =
    trace.routeNote || trace.requirements.length > 0 || trace.engine ||
    (trace.candidateCount ?? null) !== null || trace.ranked.length > 0 ||
    trace.verdicts.length > 0 || trace.final || trace.error
  if (!hasAnything && !trace.statusLine) return null
  const verdictFor = (id: string) => verdictForCandidate(trace.verdicts, id)

  return (
    <div className="trace">
      <button className="trace-head" onClick={() => patchTrace(msgId, (t) => ({ ...t, open: !t.open }))}>
        <span className="trace-title">🔍 How I verified this</span>
        <span className={`chev ${trace.open ? 'open' : ''}`}>▾</span>
      </button>
      {trace.open && (
        <ol className="timeline">
          {trace.routeNote && (
            <li><span className="t-dot" /><div><b>Routing</b><p>{trace.routeNote}</p></div></li>
          )}
          {trace.requirements.length > 0 && (
            <li><span className="t-dot" /><div><b>Requirements</b>
              <div className="req-chips">{trace.requirements.map((r) => (
                <span className="req-chip" key={r.id} title={r.id}>{r.description}</span>
              ))}</div>
            </div></li>
          )}
          {(trace.engine || (trace.candidateCount ?? null) !== null) && (
            <li><span className="t-dot" /><div><b>Searched SerpApi{trace.engine ? ` (${trace.engine})` : ''}</b>
              <p>{trace.candidateCount ?? trace.candidates.length} candidate{(trace.candidateCount ?? 0) === 1 ? '' : 's'} retrieved</p>
            </div></li>
          )}
          {trace.ranked.length > 0 && (
            <li><span className="t-dot" /><div><b>Ranked shortlist</b>
              <div className="ranked">
                {trace.ranked.map((r, i) => {
                  const id = String(r.candidate_id ?? r.id ?? r.name ?? i)
                  const rejected = trace.rejectedIds.includes(id)
                  return (
                    <div className={'rank-row' + (rejected ? ' struck' : '')} key={id + i}>
                      <span className="rank-n">#{r.rank ?? i + 1}</span>
                      <span className="rank-name">{String(r.name ?? id)}</span>
                      <span className="rank-reason">{rankReasonFor(verdictFor(id)?.overall_status)}</span>
                    </div>
                  )
                })}
              </div>
            </div></li>
          )}
          {trace.verifying && (
            <li><span className="t-dot pulse" /><div><b>Jev check</b>
              <p><span className="spinner" />Verifying {trace.verifying.candidate_name}…</p>
            </div></li>
          )}
          {trace.verdicts.map((v) => (
            <li key={v.candidate_id}><span className="t-dot" /><div>
              <b className={trace.rejectedIds.includes(v.candidate_id) ? 'struck-text' : ''}>
                {v.candidate_name || v.candidate_id} → <VerdictPill status={v.overall_status} />
              </b>
              <div className="verdict-rows">
                {v.requirements.map((r, i) => (
                  <div className="verdict-row" key={i}>
                    <span className="verdict-req">{r.requirement ?? r.requirement_id ?? r.id ?? `req ${i + 1}`}{r.reason ? <small>{r.reason}</small> : null}</span>
                    <VerdictPill status={r.status} />
                  </div>
                ))}
              </div>
            </div></li>
          ))}
          {trace.candidates.length > 0 && trace.ranked.length === 0 && trace.verdicts.length === 0 && (
            <li><span className="t-dot" /><div><b>Candidates</b>
              <div className="ranked">
                {trace.candidates.slice(0, 6).map((c, i) => {
                  const id = candId(c)
                  const rejected = trace.rejectedIds.includes(id)
                  const v = verdictFor(id)
                  return (
                    <div className={'rank-row' + (rejected ? ' struck' : '')} key={id + i}>
                      <span className="rank-n">#{i + 1}</span>
                      <span className="rank-name">{candName(c)}</span>
                      {v && <VerdictPill status={v.overall_status} />}
                    </div>
                  )
                })}
              </div>
            </div></li>
          )}
          {trace.final && <li><span className="t-dot final-dot" /><div><FinalCard fin={trace.final} /></div></li>}
          {trace.error && <li><span className="t-dot err" /><div><b>Failed step</b><p className="err-text">{trace.error}</p></div></li>}
        </ol>
      )}
    </div>
  )
}

function VerdictPill({ status }: { status: string }) {
  return <span className={`vpill ${verdictClass(status)}`}>{status}</span>
}

function FinalCard({ fin }: { fin: NonNullable<TraceState['final']> }) {
  const st = fin.status.toLowerCase()
  const vover = fin.verification?.overall_status?.toUpperCase() ?? ''
  const verified = st === 'verified' || vover === 'VERIFIED'
  const needsReview = st.includes('review') || st.includes('needs_human') || vover === 'NEEDS_REVIEW' || vover === 'UNVERIFIED' || (!verified && fin.selected_candidate)
  const c = fin.selected_candidate
  const flagged = (fin.verification?.requirements ?? []).filter((r) => r.status.toUpperCase() !== 'SATISFIED')

  if (verified && c) {
    return (
      <div className="final ok">
        <span className="final-badge">✓ VERIFIED</span>
        <div className="final-name">{candName(c)}</div>
        <div className="final-meta">
          {fmtVal(c.price) && <span>{fmtVal(c.price)}</span>}
          {fmtVal(c.rating) && <span>★ {fmtVal(c.rating)}</span>}
          {candUrl(c) && <a href={candUrl(c)!} target="_blank" rel="noreferrer">view source ↗</a>}
        </div>
        {fin.run_id && <div className="run-id">run {fin.run_id}</div>}
      </div>
    )
  }
  if (needsReview && c) {
    return (
      <div className="final warn">
        <span className="final-badge warn">◷ NEEDS REVIEW</span>
        <div className="final-name">{candName(c)}</div>
        <p className="flag-intro">Best match is <b>not verified</b> — please confirm:</p>
        <ul className="flag-list">
          {flagged.length === 0 && <li>Unverified overall status — confirm details with the seller before booking.</li>}
          {flagged.map((r, i) => (
            <li key={i}><VerdictPill status={r.status} /> {r.requirement ?? r.requirement_id ?? `requirement ${i + 1}`}{r.reason ? ` — ${r.reason}` : ''}</li>
          ))}
        </ul>
        <div className="final-meta">
          {fmtVal(c.price) && <span>{fmtVal(c.price)}</span>}
          {fmtVal(c.rating) && <span>★ {fmtVal(c.rating)}</span>}
          {candUrl(c) && <a href={candUrl(c)!} target="_blank" rel="noreferrer">view source ↗</a>}
        </div>
        {fin.run_id && <div className="run-id">run {fin.run_id}</div>}
      </div>
    )
  }
  return (
    <div className="final plain">
      <span className="final-badge plain">✓ ANSWER</span>
      <p>No search was needed — direct answer above.</p>
      {fin.run_id && <div className="run-id">run {fin.run_id}</div>}
    </div>
  )
}
