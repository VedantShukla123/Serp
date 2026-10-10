import { useEffect, useState } from 'react'
import { go } from './route'
import { VerdictPill } from './Trace'

/* Developer Hub — documents ONLY what exists in this repository:
   app/api/routes.py, app/models/schemas.py, app/mcp/adapter.py, run.py. */

const API_BASE = 'http://localhost:8000'
type Tab = 'overview' | 'api' | 'mcp' | 'sdks' | 'trace'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'api', label: 'REST API' },
  { id: 'mcp', label: 'MCP' },
  { id: 'sdks', label: 'SDKs & integrations' },
  { id: 'trace', label: 'Trace inspector' },
]

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState<'idle' | 'ok' | 'fail'>('idle')
  return (
    <button className="copy" onClick={() => {
      navigator.clipboard?.writeText(text).then(() => setDone('ok'), () => setDone('fail'))
      setTimeout(() => setDone('idle'), 1600)
    }}>{done === 'ok' ? 'Copied' : done === 'fail' ? 'Copy failed' : 'Copy'}</button>
  )
}

function Code({ children, lang }: { children: string; lang: string }) {
  return (
    <div className="code">
      <div className="code-bar"><span>{lang}</span><Copy text={children} /></div>
      <pre><code>{children}</code></pre>
    </div>
  )
}

type Ep = { m: 'GET' | 'POST'; path: string; body?: string; desc: string; demo?: boolean }
const ENDPOINTS: { group: string; items: Ep[] }[] = [
  { group: 'Verification', items: [
    { m: 'POST', path: '/v1/find-and-verify', body: '{ request, action?="search", max_candidates?=15, engine? }', desc: 'Full pipeline: parse requirements → SerpApi search → LLM rank → Jev verify → decision. Returns the run record (status, requirements, ranked_candidates, attempts, selected_candidate, verification).' },
    { m: 'POST', path: '/v1/verify', body: '{ requirements: Requirement[], candidate: Candidate }', desc: 'Verify one caller-supplied candidate. Returns { overall_status, requirements: [{ requirement_id, status, reason, … }] }.' },
  ] },
  { group: 'Runs & evidence', items: [
    { m: 'GET', path: '/v1/runs?limit=50', desc: 'Recent runs: run_id, created_at, request.' },
    { m: 'GET', path: '/v1/runs/{run_id}', desc: 'Stored run record. Ranking reasons are status-based text, never raw ranker claims.' },
    { m: 'GET', path: '/v1/runs/{run_id}/evidence', desc: 'Candidates as normalised from SerpApi, the raw SerpApi payload, and every Jev attempt.' },
  ] },
  { group: 'Agent chat', items: [
    { m: 'POST', path: '/v1/agent/chat', body: '{ message, session_id? }', desc: 'One chat turn: { reply, status, run_id, selected_candidate, verification, attempts, session_id }.' },
    { m: 'GET', path: '/v1/agent/chat/stream?message=…&session_id=…', desc: 'Server-Sent Events: status, requirements, searching, candidates, ranking, verifying, verdict, final (or error).' },
  ] },
  { group: 'Booking simulator (demo only — no reservation, no payment)', items: [
    { m: 'GET', path: '/v1/runs/{run_id}/candidates/{candidate_id}/booking-context', desc: 'Hotel, listed prices and Jev status resolved server-side from the stored run.', demo: true },
    { m: 'POST', path: '/v1/bookings/preview', body: '{ run_id, candidate_id, guest_name, email, guests, check_in, check_out }', desc: 'Validate guest details and show the review. REJECTED → 409.', demo: true },
    { m: 'POST', path: '/v1/bookings', body: '{ …same, acknowledge_unverified }', desc: 'Create a SIM- demo record. Not VERIFIED requires acknowledge_unverified=true.', demo: true },
    { m: 'GET', path: '/v1/bookings/{booking_id}', desc: 'Read a simulated booking record.', demo: true },
  ] },
  { group: 'Service', items: [
    { m: 'GET', path: '/health', desc: 'ready flag and any missing_credentials (names only, never values).' },
  ] },
]

const CURL_FIND = `curl -s ${API_BASE}/v1/find-and-verify \\
  -H "Content-Type: application/json" \\
  -d '{"request": "Hotel in Goa under Rs 10,000 for 2 people, beachfront, breakfast included, free cancellation", "action": "book_hotel"}'`

const CURL_STREAM = `curl -N "${API_BASE}/v1/agent/chat/stream?message=Hotel%20in%20Goa%20under%20Rs%2010000%20for%202%20people"`

const RESPONSE_SHAPE = `{
  "run_id": "c28bb2b65036",
  "status": "needs_human_review",        // verified | needs_human_review | no_verified_match | error
  "requirements": [{ "id": "guests", "description": "Must sleep at least 2 guests", "importance": "required" }, …],
  "ranked_candidates": [{ "candidate_id": "c3", "rank": 1, "reason": "Ranked as a relevant candidate; some required points remain unverified." }, …],
  "attempts": [{ "candidate_id": "c3", "verification": {
      "overall_status": "UNVERIFIED",      // VERIFIED | UNVERIFIED | REJECTED
      "requirements": [{ "requirement_id": "guests", "status": "UNKNOWN", "reason": "…" }, …] } }, …],
  "selected_candidate": { "candidate_id": "c3", "name": "…", "price": "…" },
  "verification": { "overall_status": "UNVERIFIED", … }
}`

const PY_ADAPTER = `# Run from the repository root (uses the same .env as the API server).
from app.mcp import adapter

run = adapter.find_and_verify(
    "Hotel in Goa under Rs 10,000 for 2 people, beachfront, free cancellation",
    action="book_hotel",
)
print(run.status)
for a in run.attempts:
    print(a.candidate_id, a.verification.overall_status)

evidence = adapter.get_evidence(run.run_id)   # candidates + raw SerpApi + attempts`

const CLI = `python run.py --serve                       # start the API on :8000
python run.py --action book_hotel "Hotel in Goa under Rs 10,000 for 2 people, beachfront"`

export default function Developers({ sub }: { sub: string | null }) {
  const tab: Tab = (TABS.find((t) => t.id === sub)?.id) ?? 'overview'
  return (
    <div className="page-scroll">
      <div className="pg-page devs enter">
        <header className="page-head">
          <div>
            <span className="eyebrow">Developers</span>
            <h1>Put a verification gate in front of agent actions.</h1>
            <p className="lede">ProofGate exposes one capability through several interfaces: turn a requested action into requirements, gather evidence, have Jev rule on each requirement, and return a decision your agent can act on — or escalate.</p>
          </div>
          <a className="btn secondary" href={`${API_BASE}/docs`} target="_blank" rel="noreferrer">Open FastAPI docs ↗</a>
        </header>

        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={'tab' + (tab === t.id ? ' on' : '')}
              onClick={() => go(`/app/developers/${t.id}`)}>{t.label}</button>
          ))}
        </nav>

        {tab === 'overview' && (
          <div className="dev-grid enter" key="o">
            <section className="card pad span2">
              <h3>Integration model</h3>
              <div className="flow">
                {['Agent proposes an action', 'Requirements extracted', 'Evidence gathered (SerpApi)', 'Jev rules per requirement', 'Policy decision', 'Human approval if needed'].map((s, i) => (
                  <div className="flow-step" key={s}><span>{i + 1}</span>{s}</div>
                ))}
              </div>
              <p className="muted sm">Decision rules are deterministic code, not LLM output: any required point <b>CONTRADICTED</b> → <VerdictPill status="REJECTED" />; any required point <b>UNKNOWN</b> → <VerdictPill status="UNVERIFIED" /> (human review); all required <b>SATISFIED</b> → <VerdictPill status="VERIFIED" />. UNKNOWN is never collapsed into CONTRADICTED.</p>
            </section>
            {[
              { t: 'REST API', d: 'FastAPI service with typed request/response models.', s: 'Available', to: 'api' },
              { t: 'MCP adapter', d: 'Python functions shaped for MCP tools. Server transport not bundled yet.', s: 'Adapter only', to: 'mcp' },
              { t: 'Trace inspector', d: 'Read stored runs, verdicts and evidence from the API.', s: 'Available', to: 'trace' },
            ].map((c) => (
              <button key={c.t} className="card pad link-card" onClick={() => go(`/app/developers/${c.to}`)}>
                <span className={'status-tag' + (c.s === 'Available' ? ' ok' : ' warn')}>{c.s}</span>
                <h3>{c.t}</h3><p className="muted sm">{c.d}</p><span className="arrow">→</span>
              </button>
            ))}
            <section className="card pad span2">
              <h3>Run it locally</h3>
              <Code lang="shell">{CLI}</Code>
              <p className="muted sm">Server configuration is read from <code>.env</code> (see <code>.env.example</code>): <code>SERPAPI_API_KEY</code>, <code>LLM_API_KEY</code>, <code>LLM_BASE_URL</code>, <code>LLM_MODEL</code>, <code>JEV_API_KEY</code>, <code>JEV_ENDPOINT</code>, <code>JEV_MODEL</code>, <code>JEV_SATISFIED_AT</code>, <code>JEV_CONTRADICTED_BELOW</code>, <code>PROOFGATE_DB_PATH</code>. Without credentials the pipeline fails loudly (502) instead of returning fabricated results.</p>
            </section>
          </div>
        )}

        {tab === 'api' && (
          <div className="enter" key="a">
            <div className="callout warn"><b>Local demo build:</b> the API does not enforce authentication yet. <code>PROOFGATE_API_KEY</code> exists in configuration but is not checked by any route — do not expose this server publicly.</div>
            {ENDPOINTS.map((g) => (
              <section className="card pad ep-group" key={g.group}>
                <h3>{g.group}</h3>
                {g.items.map((e) => (
                  <div className="ep" key={e.m + e.path}>
                    <div className="ep-line"><span className={`method ${e.m.toLowerCase()}`}>{e.m}</span><code className="ep-path">{e.path}</code>{e.demo && <span className="status-tag warn">demo</span>}</div>
                    {e.body && <code className="ep-body">{e.body}</code>}
                    <p className="muted sm">{e.desc}</p>
                  </div>
                ))}
              </section>
            ))}
            <div className="dev-grid">
              <section className="card pad"><h3>Run the full pipeline</h3><Code lang="shell">{CURL_FIND}</Code></section>
              <section className="card pad"><h3>Stream the trace (SSE)</h3><Code lang="shell">{CURL_STREAM}</Code></section>
              <section className="card pad span2"><h3>Response shape (abridged)</h3><Code lang="json">{RESPONSE_SHAPE}</Code>
                <p className="muted sm">Errors: missing credentials or upstream failures return <b>502</b> with a detail message — they are never converted into verification results.</p></section>
            </div>
          </div>
        )}

        {tab === 'mcp' && (
          <div className="dev-grid enter" key="m">
            <section className="card pad span2">
              <div className="card-head"><h3>MCP adapter</h3><span className="status-tag warn">Adapter available · server coming soon</span></div>
              <p><code>app/mcp/adapter.py</code> is a thin, dependency-free wrapper around the same core pipeline. Each function loads server-side settings and delegates to <code>app.services.pipeline</code>, <code>app.services.jev_verifier</code> and <code>app.storage.store</code> — no duplicated logic. It is designed to be registered as MCP tools.</p>
              <p className="muted sm"><b>Honest status:</b> this repository does not yet ship an MCP server or transport (no stdio/HTTP MCP entry point and no <code>mcp</code> package dependency), so there is no client configuration to paste into an MCP host today. Use the functions in-process from Python, or call the REST API.</p>
            </section>
            {[
              { n: 'find_and_verify', sig: 'find_and_verify(request: str, action: str = "search", max_candidates: int = 15, engine: str | None = None) -> RunRecord', d: 'Run the full find-and-verify pipeline with server-side settings.' },
              { n: 'verify_candidate', sig: 'verify_candidate(requirements: list[Requirement], candidate: Candidate) -> VerificationResult', d: 'Verify one caller-supplied candidate.' },
              { n: 'get_run', sig: 'get_run(run_id: str) -> dict', d: 'Persisted run record (raises KeyError when unknown). Ranking reasons are status-based.' },
              { n: 'get_evidence', sig: 'get_evidence(run_id: str) -> dict', d: 'Candidates + raw SerpApi payload + attempts for a run.' },
            ].map((f) => (
              <section className="card pad" key={f.n}>
                <h3 className="mono">{f.n}</h3>
                <code className="ep-body">{f.sig}</code>
                <p className="muted sm">{f.d}</p>
              </section>
            ))}
            <section className="card pad span2"><h3>Use it today (in-process)</h3><Code lang="python">{PY_ADAPTER}</Code></section>
          </div>
        )}

        {tab === 'sdks' && (
          <div className="dev-grid enter" key="s">
            {[
              { t: 'REST over HTTP', d: 'Any HTTP client: curl, fetch, httpx, requests. Endpoints in the REST API tab.', s: 'Available' },
              { t: 'Server-Sent Events', d: 'Progressive trace from /v1/agent/chat/stream — the Playground uses it.', s: 'Available' },
              { t: 'Python (in-process)', d: 'Import app.mcp.adapter or app.services.pipeline from this repository.', s: 'Available' },
              { t: 'CLI', d: 'python run.py "request" — prints ranking, verdicts and run_id.', s: 'Available' },
              { t: 'MCP server', d: 'Stdio/HTTP transport registering the adapter functions as tools.', s: 'Coming soon' },
              { t: 'Python package (pip)', d: 'Installable client library.', s: 'Coming soon' },
              { t: 'TypeScript SDK', d: 'Typed client for Node and browsers.', s: 'Coming soon' },
              { t: 'Booking providers', d: 'Real reservations and payments. Today bookings are simulated demo records only.', s: 'Not available' },
            ].map((c) => (
              <section key={c.t} className={'card pad sdk' + (c.s === 'Available' ? '' : ' muted-card')}>
                <span className={'status-tag' + (c.s === 'Available' ? ' ok' : c.s === 'Coming soon' ? ' warn' : ' bad')}>{c.s}</span>
                <h3>{c.t}</h3><p className="muted sm">{c.d}</p>
              </section>
            ))}
          </div>
        )}

        {tab === 'trace' && <TraceInspector />}
      </div>
    </div>
  )
}

type RunRow = { run_id: string; created_at: string; request: string }
type Attempt = { candidate_id: string; candidate_name?: string; verification: { overall_status: string; requirements: { requirement_id: string; status: string; reason?: string }[] } }
type RunDoc = { run_id: string; status: string; request: string; candidate_count: number; requirements: { id: string; description: string }[]; ranked_candidates: { candidate_id: string; rank: number; reason: string }[]; attempts: Attempt[]; candidates?: { candidate_id: string; name?: string }[] }

function TraceInspector() {
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [id, setId] = useState('')
  const [doc, setDoc] = useState<RunDoc | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch('/v1/runs?limit=12').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setRuns).catch((e: Error) => setErr(`Could not list runs (${e.message}). Is the API running on :8000?`))
  }, [])

  function open(runId: string) {
    setId(runId); setLoading(true); setErr(null)
    fetch(`/v1/runs/${encodeURIComponent(runId)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? 'run not found' : `HTTP ${r.status}`))))
      .then(setDoc).catch((e: Error) => { setDoc(null); setErr(e.message) }).finally(() => setLoading(false))
  }

  const names = new Map((doc?.candidates ?? []).map((c) => [c.candidate_id, c.name]))
  return (
    <div className="dev-grid enter" key="t">
      <section className="card pad">
        <h3>Stored runs</h3>
        <p className="muted sm">Live data from <code>GET /v1/runs</code>. Opening a run calls <code>GET /v1/runs/{'{run_id}'}</code> — no new search, no credits.</p>
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (id.trim()) open(id.trim()) }}>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="run_id" aria-label="Run ID" />
          <button className="btn primary sm" disabled={!id.trim() || loading}>{loading ? 'Loading…' : 'Inspect'}</button>
        </form>
        {err && <p className="err-text sm">{err}</p>}
        <ul className="run-rows">
          {(runs ?? []).map((r) => (
            <li key={r.run_id}><button className={doc?.run_id === r.run_id ? 'on' : ''} onClick={() => open(r.run_id)}>
              <code>{r.run_id}</code><span>{r.request}</span><small>{new Date(r.created_at).toLocaleString()}</small>
            </button></li>
          ))}
          {runs && runs.length === 0 && <li className="muted sm">No stored runs yet — run one in the Playground.</li>}
        </ul>
      </section>
      <section className="card pad">
        {!doc ? <div className="empty-state"><div className="empty-ico" aria-hidden>◎</div><h3>Pick a run</h3><p className="muted sm">See every candidate decision, requirement status and the reason Jev gave.</p></div> : (
          <>
            <div className="card-head"><h3>Run {doc.run_id}</h3><span className="status-tag">{doc.status.replace(/_/g, ' ')}</span></div>
            <p className="quote">{doc.request}</p>
            <p className="muted sm">{doc.candidate_count} candidates · {doc.attempts.length} checked by Jev · <a href={`${API_BASE}/v1/runs/${doc.run_id}/evidence`} target="_blank" rel="noreferrer">raw evidence JSON ↗</a></p>
            <div className="matrix-wrap">
              <table className="matrix">
                <thead><tr><th>#</th><th>Candidate</th>{doc.requirements.map((r) => <th key={r.id} title={r.description}>{r.id.replace(/_/g, ' ')}</th>)}<th>Overall</th></tr></thead>
                <tbody>
                  {doc.ranked_candidates.map((rc) => {
                    const a = doc.attempts.find((x) => x.candidate_id === rc.candidate_id)
                    return (
                      <tr key={rc.candidate_id} title={rc.reason}>
                        <td>{rc.rank}</td>
                        <td className="m-name">{a?.candidate_name && a.candidate_name !== rc.candidate_id ? a.candidate_name : names.get(rc.candidate_id) ?? rc.candidate_id}</td>
                        {doc.requirements.map((req) => {
                          const v = a?.verification.requirements.find((x) => x.requirement_id === req.id)
                          const s = v?.status
                          return <td key={req.id}><span className={'cell ' + (s === 'SATISFIED' ? 'ok' : s === 'CONTRADICTED' ? 'bad' : s === 'UNKNOWN' ? 'warn' : '')} title={v?.reason ?? 'not checked'}>{s === 'SATISFIED' ? '✓' : s === 'CONTRADICTED' ? '✕' : s === 'UNKNOWN' ? '?' : '—'}</span></td>
                        })}
                        <td>{a ? <VerdictPill status={a.verification.overall_status} /> : <span className="vpill idle">not checked</span>}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
