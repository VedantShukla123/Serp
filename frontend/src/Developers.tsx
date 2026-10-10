import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { go } from './route'
import { VerdictPill } from './Trace'
import {
  API_BASE, AVAIL, apiUrl, checkRunId, describeError, example, initialRun, latestGuard, missingStatus, RUN_STATUS_TEXT, RUNS_PAGE, shortId, statusCounts, traceRows,
  type Avail, type LoadError, type Shell, type StoredRunDoc, type TraceRow,
} from './devhub'
import { COST, epKey, filterGroups, GROUPS, PLACEHOLDER_IDS, type Cost, type ExampleIds } from './apiCatalog'
import { MCP_TOOLS, mcpCmd, mcpConfig, PLACEHOLDER_NIX } from './mcpSetup'
import { GROUP_INFO, GROUP_ORDER, INTEGRATIONS } from './sdkCatalog'

/* Developer Hub — documents ONLY what exists in this repository:
   app/api/routes.py, app/models/schemas.py, app/mcp/adapter.py, app/main.py, run.py. */

type Tab = 'overview' | 'api' | 'mcp' | 'sdks' | 'trace'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'api', label: 'REST API' },
  { id: 'mcp', label: 'MCP' },
  { id: 'sdks', label: 'SDKs & integrations' },
  { id: 'trace', label: 'Trace inspector' },
]

/* ---------------------------------------------------------------- shared bits */

export function AvailBadge({ kind }: { kind: Avail }) {
  const a = AVAIL[kind]
  return <span className={`avail ${a.tone}`} title={a.meaning}><span aria-hidden>{a.icon}</span>{a.label}</span>
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <button type="button" className={`copy ${state}`} aria-label={`${label}${state === 'ok' ? ' (copied)' : ''}`}
      onClick={async () => {
        const ok = await copyText(text)
        setState(ok ? 'ok' : 'fail')
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setState('idle'), 2000)
      }}>
      <span aria-live="polite">{state === 'ok' ? '✓ Copied' : state === 'fail' ? 'Copy failed — select the text' : label}</span>
    </button>
  )
}

function Code({ code, lang, note }: { code: string; lang: string; note?: string }) {
  return (
    <figure className="code">
      <figcaption className="code-bar"><span>{lang}</span><CopyButton text={code} label={`Copy ${lang}`} /></figcaption>
      <pre tabIndex={0}><code>{code}</code></pre>
      {note && <p className="code-note">{note}</p>}
    </figure>
  )
}

const SHELL_KEY = 'proofgate.devhub.shell'
function useShell(): [Shell, (s: Shell) => void] {
  const [shell, setShellState] = useState<Shell>(() => {
    try { const s = localStorage.getItem(SHELL_KEY); if (s === 'bash' || s === 'powershell') return s } catch { /* ignore */ }
    return /Win/i.test(navigator.platform || navigator.userAgent) ? 'powershell' : 'bash'
  })
  const setShell = (s: Shell) => { setShellState(s); try { localStorage.setItem(SHELL_KEY, s) } catch { /* ignore */ } }
  return [shell, setShell]
}

function ShellSwitch({ shell, setShell }: { shell: Shell; setShell: (s: Shell) => void }) {
  return (
    <div className="seg" role="group" aria-label="Example shell">
      <button type="button" aria-pressed={shell === 'powershell'} onClick={() => setShell('powershell')}>Windows PowerShell</button>
      <button type="button" aria-pressed={shell === 'bash'} onClick={() => setShell('bash')}>bash · macOS · Linux · Git Bash</button>
    </div>
  )
}

/** fetch JSON with timeout + cancellation; throws {status} on HTTP errors. */
async function getJson<T>(url: string, signal: AbortSignal, timeoutMs = 12000): Promise<T> {
  const ctl = new AbortController()
  const t = window.setTimeout(() => ctl.abort(), timeoutMs)
  const onAbort = () => ctl.abort()
  signal.addEventListener('abort', onAbort)
  try {
    const r = await fetch(/^https?:/.test(url) ? url : apiUrl(url), { signal: ctl.signal })
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status })
    return (await r.json()) as T
  } finally {
    window.clearTimeout(t)
    signal.removeEventListener('abort', onAbort)
  }
}

function ErrorBox({ err, onRetry, children }: { err: LoadError; onRetry?: () => void; children?: ReactNode }) {
  return (
    <div className={`errbox ${err.kind}`} role="alert">
      <b>{err.title}</b>
      <p>{err.detail}</p>
      <div className="errbox-actions">{onRetry && <button className="btn secondary sm" onClick={onRetry}>Try again</button>}{children}</div>
    </div>
  )
}

/** Latest stored run id, so copied examples work on this machine (null if none / API down). */
function useLatestRunId(): string | null {
  const [runId, setRunId] = useState<string | null>(null)
  useEffect(() => {
    const ctl = new AbortController()
    getJson<{ run_id: string }[]>('/v1/runs?limit=1', ctl.signal).then((r) => setRunId(r[0]?.run_id ?? null)).catch(() => setRunId(null))
    return () => ctl.abort()
  }, [])
  return runId
}

/* ---------------------------------------------------------------- page */

export default function Developers({ sub, arg }: { sub: string | null; arg: string | null }) {
  const tab: Tab = TABS.find((t) => t.id === sub)?.id ?? 'overview'
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [shell, setShell] = useShell()

  // Switching tabs starts the new tab at the top (the scroll container persists across tabs).
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [tab])

  function onTabKey(e: KeyboardEvent, i: number) {
    const n = TABS.length
    const j = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (j < 0) return
    e.preventDefault()
    go(`/app/developers/${TABS[j].id}`)
    tabRefs.current[j]?.focus()
  }

  return (
    <div className="page-scroll" ref={scrollRef}>
      <div className="pg-page devs dev2 enter">
        <header className="dev-head">
          <div>
            <span className="eyebrow">Developers</span>
            <h1>Build with ProofGate</h1>
            <p className="muted">Verify an AI agent’s proposed action against requirements and evidence before allowing it to proceed.</p>
          </div>
          <a className="btn secondary sm" href={`${API_BASE}/docs`} target="_blank" rel="noreferrer" title="Interactive API docs served by your local backend (localhost:8000)">
            Local API docs ↗
          </a>
        </header>

        <div className="tabs" role="tablist" aria-label="Developer sections">
          {TABS.map((t, i) => (
            <button key={t.id} ref={(el) => { tabRefs.current[i] = el }} role="tab" id={`tab-${t.id}`}
              aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1}
              className={'tab' + (tab === t.id ? ' on' : '')} onKeyDown={(e) => onTabKey(e, i)}
              onClick={() => go(`/app/developers/${t.id}`)}>{t.label}</button>
          ))}
        </div>

        <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tabpanel" key={tab}>
          {tab === 'overview' && <Overview />}
          {tab === 'api' && <RestApi shell={shell} setShell={setShell} openKey={arg} />}
          {tab === 'mcp' && <Mcp shell={shell} setShell={setShell} />}
          {tab === 'sdks' && <Sdks shell={shell} setShell={setShell} />}
          {tab === 'trace' && <TraceInspector runId={arg} />}
        </section>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- overview */

const FLOW = ['Action', 'Requirements', 'Evidence', 'Jev', 'Decision', 'Human review']

const CAPABILITIES: { name: string; kind: Avail; what: string; to: Tab; sub?: string; code?: string }[] = [
  { name: 'REST API', kind: 'now', what: 'Verify requests, read runs and evidence over HTTP.', to: 'api' },
  { name: 'SSE trace', kind: 'now', what: 'Stream every pipeline step as it happens.', to: 'api', sub: 'get-v1-agent-chat-stream' },
  { name: 'MCP server (stdio)', kind: 'now', what: 'Four tools for MCP hosts via run_mcp.py; tested.', to: 'mcp' },
  { name: 'CLI (run.py)', kind: 'inproc', what: 'Run a verification from a local checkout.', to: 'sdks' },
  { name: 'Action simulator', kind: 'demo', what: 'Simulated hotel bookings and product orders only.', to: 'api', sub: 'get-v1-runs-run-id-candidates-candidate-id-action-context' },
  { name: 'Python adapter', kind: 'inproc', what: 'The same four functions, imported from this repo.', to: 'mcp' },
  { name: 'Python client', kind: 'inproc', what: 'proofgate_client — available locally, not published. TypeScript SDK not built yet.', to: 'sdks', code: 'from proofgate_client import ProofGateClient' },
  { name: 'API authentication', kind: 'none', what: 'The local server accepts every request.', to: 'api' },
]

type Health = { s: 'idle' | 'loading' } | { s: 'ok'; ready: boolean; missing: string[] } | { s: 'error'; err: LoadError }

function Overview() {
  const ids = useExampleIds()
  const [health, setHealth] = useState<Health>({ s: 'idle' })
  const latest = ids.latestRun

  function checkHealth() {
    setHealth({ s: 'loading' })
    getJson<{ ready?: boolean; missing_credentials?: string[] }>(`${API_BASE}/health`, new AbortController().signal, 6000)
      .then((j) => setHealth({ s: 'ok', ready: j.ready === true, missing: Array.isArray(j.missing_credentials) ? j.missing_credentials : [] }))
      .catch((e) => setHealth({ s: 'error', err: describeError(e, (e as { status?: number })?.status) }))
  }

  return (
    <div className="ov">
      <ol className="flow-line" aria-label="How ProofGate decides">
        {FLOW.map((s, i) => <li key={s} className={i === FLOW.length - 1 ? 'opt' : ''}>{s}{i === FLOW.length - 1 && <small> when needed</small>}</li>)}
      </ol>

      <div className="qa-grid">
        <section className="card pad qa">
          <div className="qa-head"><h2 className="h3">Check API health</h2><span className="cost ok">Free · no search</span></div>
          <p className="muted sm">Calls <code>GET /health</code> on your local server.</p>
          <div className="qa-result" aria-live="polite">
            {health.s === 'idle' && <span className="muted sm">Not checked yet.</span>}
            {health.s === 'loading' && <span className="sm"><span className="spinner xs" /> Checking…</span>}
            {health.s === 'ok' && (health.ready
              ? <span className="hc ok">● Ready — all API keys configured</span>
              : <span className="hc warn">● Running, but missing: {health.missing.join(', ') || 'credentials'}</span>)}
            {health.s === 'error' && <span className="hc bad">● {health.err.title}. {health.err.detail}</span>}
          </div>
          <div className="qa-actions">
            <button className="btn primary sm" onClick={checkHealth} disabled={health.s === 'loading'}>Check now</button>
            <a className="link sm" href={`${API_BASE}/health`} target="_blank" rel="noreferrer">Open /health ↗</a>
          </div>
        </section>

        <section className="card pad qa">
          <div className="qa-head"><h2 className="h3">Inspect a stored run</h2><span className="cost ok">Free · no search</span></div>
          <p className="muted sm">See requirements, Jev verdicts and evidence for a past run.</p>
          <div className="qa-result">
            {latest ? (
              <span className="qa-latest">
                <span className="qa-req" title={latest.request}>{latest.request}</span>
                <span className="qa-meta">
                  {latest.status && <span className={`rl-status ${latest.status}`}>{latest.status.replace(/_/g, ' ')}</span>}
                  {latest.created_at && <time dateTime={latest.created_at}>{new Date(latest.created_at).toLocaleString()}</time>}
                </span>
                <span className="qa-id">Run <code title={latest.run_id}>{latest.run_id}</code><CopyButton text={latest.run_id} label="Copy ID" /></span>
              </span>
            ) : <span className="muted sm">{ids.loaded ? 'No stored runs yet.' : 'Looking for runs…'}</span>}
          </div>
          <div className="qa-actions">
            <button className="btn primary sm" onClick={() => go(latest ? `/app/developers/trace/${encodeURIComponent(latest.run_id)}` : '/app/developers/trace')}>
              {latest ? 'Open latest run' : 'Open Trace inspector'}
            </button>
            {latest && <button className="link sm" onClick={() => go('/app/developers/trace')}>All runs</button>}
          </div>
        </section>

        <section className="card pad qa">
          <div className="qa-head"><h2 className="h3">Run a verification</h2><span className="cost warn">Uses API credits</span></div>
          <p className="muted sm"><code>POST /v1/find-and-verify</code> searches live and asks Jev to rule on each requirement.</p>
          <div className="qa-result"><span className="sm">Nothing runs from here — you copy the request and run it yourself.</span></div>
          <div className="qa-actions">
            <button className="btn secondary sm" onClick={() => go('/app/developers/api/post-v1-find-and-verify')}>View the request</button>
          </div>
        </section>
      </div>

      <section className="card pad caps">
        <div className="card-head"><h2 className="h3">What’s available</h2><span className="muted sm">Status in this repository today</span></div>
        <ul className="cap-grid">
          {CAPABILITIES.map((c) => (
            <li key={c.name}>
              <button onClick={() => go(`/app/developers/${c.to}${c.sub ? '/' + c.sub : ''}`)} aria-label={`${c.name}: ${AVAIL[c.kind].label}. ${c.what}`}>
                <span className="cap-top"><b>{c.name}</b><AvailBadge kind={c.kind} /></span>
                <small>{c.what}</small>
                {c.code && <code className="cap-code">{c.code}</code>}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/* ---------------------------------------------------------------- REST API explorer */

/** Real local run IDs so copied examples work: hotel endpoints get a hotel run, order endpoints a product run,
 *  each with that run's own selected candidate. Free local reads only; placeholders if none exist. */
type LatestRun = { run_id: string; request: string; created_at?: string; status: string | null }

function useExampleIds(): ExampleIds & { latestRun: LatestRun | null; loaded: boolean } {
  const [state, setState] = useState<{ ids: ExampleIds; latestRun: LatestRun | null; loaded: boolean }>(
    { ids: PLACEHOLDER_IDS, latestRun: null, loaded: false })
  useEffect(() => {
    const ctl = new AbortController()
    ;(async () => {
      const rows = await getJson<{ run_id: string; request: string; created_at?: string }[]>('/v1/runs?limit=15', ctl.signal).catch(() => [])
      let latestStatus: string | null = null
      const ids = { ...PLACEHOLDER_IDS }
      if (rows[0]) ids.anyRun = rows[0].run_id
      let needHotel = true, needProduct = true
      for (const r of rows) {
        if (!needHotel && !needProduct) break
        const doc = await getJson<{ status?: string; target_type?: string; selected_candidate?: { candidate_id?: string } | null; candidates?: { candidate_id: string }[] }>(
          `/v1/runs/${encodeURIComponent(r.run_id)}`, ctl.signal).catch(() => null)
        if (r === rows[0]) latestStatus = doc?.status ?? null      // real status, from the run details
        const cand = doc?.selected_candidate?.candidate_id ?? doc?.candidates?.[0]?.candidate_id
        if (!doc || !cand) continue
        if (needHotel && doc.target_type === 'hotel') { ids.hotelRun = r.run_id; ids.hotelCand = cand; needHotel = false }
        if (needProduct && doc.target_type === 'product') { ids.productRun = r.run_id; ids.productCand = cand; needProduct = false }
      }
      if (!ctl.signal.aborted) setState({ ids, latestRun: rows[0] ? { ...rows[0], status: latestStatus } : null, loaded: true })
    })()
    return () => ctl.abort()
  }, [])
  return { ...state.ids, latestRun: state.latestRun, loaded: state.loaded }
}

function RestApi({ shell, setShell, openKey }: { shell: Shell; setShell: (s: Shell) => void; openKey: string | null }) {
  const ids = useExampleIds()
  const [query, setQuery] = useState('')
  const [cost, setCost] = useState<Cost | 'all'>('all')
  const groups = filterGroups(GROUPS, query, cost)
  const total = GROUPS.reduce((n, g) => n + g.items.length, 0)
  const shown = groups.reduce((n, g) => n + g.items.length, 0)
  const counts = { free: 0, paid: 0, demo: 0 } as Record<Cost, number>
  for (const g of GROUPS) for (const e of g.items) counts[e.cost]++

  // Deep link (#/app/developers/api/<key>): bring the open endpoint into view once.
  const scrolled = useRef<string | null>(null)
  useEffect(() => {
    if (!openKey || scrolled.current === openKey) return
    scrolled.current = openKey
    requestAnimationFrame(() => document.getElementById(`ep-${openKey}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [openKey])

  const toggle = (key: string) => go(openKey === key ? '/app/developers/api' : `/app/developers/api/${key}`)
  const usingReal = ids.anyRun !== PLACEHOLDER_IDS.anyRun

  return (
    <div className="api-x">
      <section className="card pad api-top">
        <div className="api-intro">
          <h2 className="h3">REST API</h2>
          <p className="muted sm">JSON over HTTP — every endpoint ProofGate implements today, with a runnable example.</p>
        </div>
        <div className="api-base">
          <span className="base-label">Base URL</span>
          <code className="base-url">{API_BASE}</code>
          <CopyButton text={API_BASE} label="Copy base URL" />
          <a className="link sm" href={`${API_BASE}/docs`} target="_blank" rel="noreferrer">FastAPI docs (/docs) ↗</a>
        </div>
        <p className="api-warn sm"><b>Local development only.</b> Not publicly hosted. No authentication — <code>PROOFGATE_API_KEY</code> is not checked by any route.</p>
        <div className="api-tools">
          <label className="search">
            <span className="sr">Search endpoints</span>
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search endpoints, e.g. runs, orders, stream" />
          </label>
          <div className="seg" role="group" aria-label="Filter by cost">
            <button type="button" aria-pressed={cost === 'all'} onClick={() => setCost('all')}>All {total}</button>
            {(['free', 'paid', 'demo'] as Cost[]).map((c) => (
              <button key={c} type="button" aria-pressed={cost === c} onClick={() => setCost(cost === c ? 'all' : c)} title={COST[c].note}>
                <span className={`dotc ${COST[c].cls}`} aria-hidden />{COST[c].label} {counts[c]}
              </button>
            ))}
          </div>
          <ShellSwitch shell={shell} setShell={setShell} />
        </div>
      </section>

      {shown === 0 && (
        <div className="card pad empty-state"><p>No endpoint matches “{query}”.</p><button className="btn secondary sm" onClick={() => { setQuery(''); setCost('all') }}>Clear filters</button></div>
      )}

      {groups.map((g) => (
        <section className="card ep-card" key={g.id} aria-labelledby={`grp-${g.id}`}>
          <h3 className="ep-gtitle" id={`grp-${g.id}`}>{g.title}</h3>
          <ul className="ep-rows">
            {g.items.map((e) => {
              const key = epKey(e)
              const open = openKey === key
              const code = e.ex ? example(e.ex(ids), shell) : null
              return (
                <li key={key} id={`ep-${key}`} className={open ? 'open' : ''}>
                  <button className="ep-row" onClick={() => toggle(key)} aria-expanded={open} aria-controls={`epd-${key}`}>
                    <span className={`method ${e.method.toLowerCase()}`}>{e.method}</span>
                    <code className="ep-path">{e.path}</code>
                    <span className="ep-purpose">{e.purpose}</span>
                    <span className={`cost ${COST[e.cost].cls}`}>{COST[e.cost].short}</span>
                    <span className="chev" aria-hidden>▾</span>
                  </button>
                  {open && (
                    <div className="ep-detail" id={`epd-${key}`}>
                      <p className={`cost-line ${COST[e.cost].cls}`}>{COST[e.cost].note}</p>
                      {e.inputs && (
                        <table className="io">
                          <caption>Parameters</caption>
                          <tbody>{e.inputs.map((f) => (
                            <tr key={f.name}><th scope="row"><code>{f.name}</code>{f.req ? <span className="req">required</span> : <span className="opt">optional</span>}</th><td>{f.type}</td><td>{f.note}</td></tr>
                          ))}</tbody>
                        </table>
                      )}
                      <dl className="ep-dl">
                        <dt>Returns</dt><dd><code>{e.returns}</code></dd>
                        <dt>Errors</dt><dd>{e.errors.join(' · ')}</dd>
                      </dl>
                      {code && <Code lang={shell === 'bash' ? 'bash' : 'PowerShell'} code={code}
                        note={[e.exNote, usingReal ? 'Uses run IDs from your local store.' : 'Replace the PASTE_… values with IDs from GET /v1/runs.', shell === 'powershell' ? 'PowerShell shows non-2xx responses as an error containing the JSON detail.' : ''].filter(Boolean).join(' ')} />}
                      {!code && e.exNote && <p className="muted sm">{e.exNote}</p>}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- MCP */

type Creds = { s: 'loading' } | { s: 'ok'; ready: boolean; missing: string[] } | { s: 'error' }

function Mcp({ shell, setShell }: { shell: Shell; setShell: (s: Shell) => void }) {
  const runId = useLatestRunId()
  const [creds, setCreds] = useState<Creds>({ s: 'loading' })
  useEffect(() => {
    const ctl = new AbortController()
    getJson<{ ready?: boolean; missing_credentials?: string[] }>(`${API_BASE}/health`, ctl.signal, 6000)
      .then((j) => setCreds({ s: 'ok', ready: j.ready === true, missing: Array.isArray(j.missing_credentials) ? j.missing_credentials : [] }))
      .catch(() => { if (!ctl.signal.aborted) setCreds({ s: 'error' }) })
    return () => ctl.abort()
  }, [])
  const win = shell === 'powershell'

  return (
    <div className="mcp2">
      <section className="card pad mcp-intro">
        <div>
          <h2 className="mcp-title">Connect ProofGate to your AI tools</h2>
          <p className="muted">ProofGate ships an MCP server, so an MCP-compatible AI app can discover and call its verification tools directly — the same pipeline as the REST API.</p>
        </div>
        <ShellSwitch shell={shell} setShell={setShell} />
      </section>

      <section className="card pad">
        <h3 className="sub-h first">Status</h3>
        <ul className="mcp-stat">
          <li><span className="st ok">● Implemented &amp; tested</span><span><b>MCP server</b> — <code>run_mcp.py</code>, built on the official MCP Python SDK 2.x; protocol tests cover handshake, tool listing and calls.</span></li>
          <li><span className="st ok">● stdio</span><span><b>Transport</b> — local stdio only. No HTTP transport is offered, so nothing is exposed on the network.</span></li>
          <li><span className="st ok">● 4 tools</span><span><b>Tools</b> — find_and_verify, verify_candidate, get_run, get_evidence, all listed and called in tests.</span></li>
          <li><span className="st neutral">○ Your step</span><span><b>Client configuration</b> — add the config below to your MCP host. This page can’t see your host, so it never shows “connected”.</span></li>
          <li>
            {creds.s === 'loading' && <span className="st neutral">… checking</span>}
            {creds.s === 'ok' && (creds.ready ? <span className="st ok">● Configured</span> : <span className="st warn">● Missing keys</span>)}
            {creds.s === 'error' && <span className="st neutral">○ Unknown</span>}
            <span><b>External credentials</b> — read from this repo’s <code>.env</code> (never from the host config).{' '}
              {creds.s === 'ok' && !creds.ready && <>Missing: {creds.missing.join(', ')}. </>}
              {creds.s === 'error' && <>Start the REST server to check, or run the <code>--check</code> command. </>}
              <small className="muted">Checked via local /health, which reads the same .env.</small></span>
          </li>
        </ul>
      </section>

      <section className="card pad">
        <h3 className="sub-h first">Quick setup <span className="muted sm">run in the repository folder</span></h3>
        <ol className="mcp-steps">
          <li><b>Install the dependencies</b> (includes the <code>mcp</code> SDK).<Code lang={win ? 'PowerShell' : 'bash'} code={mcpCmd('install', shell)} /></li>
          <li><b>Configure the local <code>.env</code></b> with <code>SERPAPI_API_KEY</code>, <code>LLM_API_KEY</code> and <code>JEV_API_KEY</code>. Only paid tools need them; get_run and get_evidence work without keys.<Code lang={win ? 'PowerShell' : 'bash'} code={mcpCmd('env', shell)} /></li>
          <li><b>Check the server</b> — should print “ProofGate MCP server OK - 4 tools”.<Code lang={win ? 'PowerShell' : 'bash'} code={mcpCmd('check', shell)} /></li>
          <li><b>Add the configuration</b> below to your MCP host (e.g. Claude Desktop’s <code>claude_desktop_config.json</code> or another host’s MCP settings) and replace the path placeholder.</li>
          <li><b>Restart the host</b> and confirm the four ProofGate tools appear in its tool list.</li>
        </ol>
      </section>

      <div className="mcp-stack">
        <section className="card pad">
          <h3 className="sub-h first">Host configuration <span className="muted sm">stdio · no secrets</span></h3>
          <Code lang="json" code={mcpConfig(shell)} />
          <ol className="steps-list mcp-replace">
            <li>In the repository folder run <code>{mcpCmd('path', shell)}</code> to get its absolute path.</li>
            <li>Replace <code>{win ? 'C:\\\\ABSOLUTE\\\\PATH\\\\TO\\\\serpapi-hackthon' : PLACEHOLDER_NIX}</code> in both lines with it{win && <> — in JSON every <code>\</code> must be written as <code>\\</code></>}.</li>
            <li>No <code>env</code> block is needed: the server loads keys from the repo’s <code>.env</code> and works from any working directory.</li>
          </ol>
        </section>

        <section className="card pad">
          <h3 className="sub-h first">Tools</h3>
          <ul className="mcp-tools">
            {MCP_TOOLS.map((t) => (
              <li key={t.n}>
                <div className="fn-head"><code className="fn-name">{t.n}</code><span className={`cost ${t.cost === 'free' ? 'ok' : 'warn'}`}>{t.cost === 'free' ? 'Free · read-only' : 'Uses API credits'}</span></div>
                <small className="muted">{t.d}</small>
                <code className="fn-sig">{t.args}</code>
              </li>
            ))}
          </ul>
          <p className="muted sm">Failures (unknown run, missing keys, upstream errors) come back as MCP tool errors — never as a verification result.</p>
        </section>
      </div>

      <section className="card pad">
        <h3 className="sub-h first">Troubleshooting</h3>
        <dl className="trouble">
          <div><dt>Tools don’t appear in the host</dt><dd>Run the <code>--check</code> command above. If it works, the host config path is wrong — use absolute paths to <code>.venv</code>’s Python and to <code>run_mcp.py</code>, then fully restart the host.</dd></div>
          <div><dt>Wrong Python / <code>No module named 'mcp'</code></dt><dd>The host is using a different interpreter. Point <code>command</code> at <code>{win ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'}</code> inside the repo and re-run step 1.</dd></div>
          <div><dt>Incorrect project path</dt><dd>“can’t open file …run_mcp.py” means the <code>args</code> path is wrong{win && ' or backslashes were not doubled'}.</dd></div>
          <div><dt><code>.env</code> or runs not found</dt><dd><code>run_mcp.py</code> switches to the repo folder itself, so <code>.env</code> and <code>proofgate.db</code> resolve correctly from any working directory. If get_run can’t find a run, check the run ID in the Trace inspector.</dd></div>
          <div><dt>Protocol errors / garbled output</dt><dd>stdout is reserved for MCP messages; ProofGate logs to stderr. Don’t wrap the command in scripts that print to stdout.</dd></div>
          <div><dt>“LLM_API_KEY is not set” from find_and_verify</dt><dd>Add the key to the repo’s <code>.env</code> (step 2). The free tools keep working without keys.</dd></div>
        </dl>
      </section>

      <details className="tech-item">
        <summary>Use the same functions directly from Python (no MCP) <span className="muted sm">in-process adapter</span></summary>
        <div className="tech-body">
          <p className="sm">Save as <code>try_adapter.py</code> in the repository root and run it with the project’s Python.{runId ? <> Uses your latest stored run, <code>{runId}</code>.</> : <> Replace <code>PASTE_RUN_ID</code> with an ID from the Trace inspector.</>}</p>
          <Code lang="python" code={pyAdapter(runId ?? 'PASTE_RUN_ID')} />
        </div>
      </details>
    </div>
  )
}

const pyAdapter = (runId: string) => `from app.mcp import adapter

run = adapter.get_run("${runId}")     # free: reads the local run store
print(run["status"])
for a in run["attempts"]:
    print(a["candidate_id"], a["verification"]["overall_status"])

evidence = adapter.get_evidence(run["run_id"])   # candidates + raw SerpApi + verdicts`

/* ---------------------------------------------------------------- SDKs */

function Sdks({ shell, setShell }: { shell: Shell; setShell: (s: Shell) => void }) {
  return (
    <div className="sdk2">
      <section className="card pad sdk-intro">
        <div>
          <h2 className="mcp-title">Get started with an integration</h2>
          <p>Every option below talks to the same verification pipeline. Pick the one that fits how your agent runs.</p>
        </div>
        <ShellSwitch shell={shell} setShell={setShell} />
      </section>

      {GROUP_ORDER.map((g) => {
        const items = INTEGRATIONS.filter((i) => i.group === g)
        if (!items.length) return null
        const compact = g === 'soon' || g === 'none'
        return (
          <section key={g} className="sdk-sec" aria-labelledby={`sdk-${g}`}>
            <div className="sdk-sec-head">
              <h3 id={`sdk-${g}`}>{GROUP_INFO[g].title}</h3>
              <span>{GROUP_INFO[g].blurb}</span>
            </div>
            {compact ? (
              <ul className="sdk-rows card">
                {items.map((i) => (
                  <li key={i.id}><b>{i.title}</b><span>{i.what}</span><span className="sdk-row-today">{i.today}</span></li>
                ))}
              </ul>
            ) : (
              <div className={'sdk-cards' + (items.length === 1 ? ' one' : '')}>
                {items.map((i) => {
                  const ex = i.code?.(shell)
                  return (
                    <article key={i.id} className={`card pad sdk-card g-${g}`}>
                      <h4>{i.title}</h4>
                      <dl className="sdk-dl">
                        <dt>What it is</dt><dd>{i.what}</dd>
                        <dt>Today</dt><dd>{i.today}</dd>
                      </dl>
                      {i.steps && <ol className="sdk-steps">{i.steps.map((s) => <li key={s}>{s}</li>)}</ol>}
                      {ex && <Code lang={ex.lang} code={ex.code} />}
                      {i.note && <p className="sdk-note">{i.note}</p>}
                      {i.link && <button className="link sm sdk-link" onClick={() => go(i.link!.to)}>{i.link.label} →</button>}
                    </article>
                  )
                })}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------------- Trace inspector */

type RunRow = { run_id: string; created_at: string; request: string }
type LoadState<T> = { s: 'idle' } | { s: 'loading' } | { s: 'ok'; data: T } | { s: 'error'; err: LoadError }

function toErr(e: unknown): LoadError {
  return describeError(e, (e as { status?: number })?.status)
}

const CELL: Record<string, { sym: string; cls: string; text: string }> = {
  SATISFIED: { sym: '✓', cls: 'ok', text: 'satisfied' },
  UNKNOWN: { sym: '?', cls: 'warn', text: 'unknown — evidence did not settle it' },
  CONTRADICTED: { sym: '✕', cls: 'bad', text: 'contradicted' },
}

type RunMeta = { status: string; target_type?: string | null } | { error: true }

function TraceInspector({ runId }: { runId: string | null }) {
  const [list, setList] = useState<LoadState<RunRow[]>>({ s: 'loading' })
  const [run, setRun] = useState<LoadState<StoredRunDoc>>({ s: 'idle' })
  const [input, setInput] = useState(runId ?? '')
  const [inputErr, setInputErr] = useState<string | null>(null)
  const [shown, setShown] = useState(RUNS_PAGE)
  const [meta, setMeta] = useState<Record<string, RunMeta>>({})   // statuses come from run details only
  const guard = useRef(latestGuard())
  const ctl = useRef<AbortController | null>(null)

  const loadList = useCallback(() => {
    setList({ s: 'loading' })
    const c = new AbortController()
    getJson<RunRow[]>('/v1/runs?limit=50', c.signal)
      .then((data) => setList({ s: 'ok', data: Array.isArray(data) ? data : [] }))
      .catch((e) => { if (!c.signal.aborted) setList({ s: 'error', err: toErr(e) }) })
    return () => c.abort()
  }, [])
  useEffect(() => loadList(), [loadList])

  // No selection yet → open the newest stored run (replace, so Back doesn't bounce here).
  useEffect(() => {
    if (list.s !== 'ok') return
    const first = initialRun(runId, list.data)
    if (first) window.location.replace(`#/app/developers/trace/${encodeURIComponent(first)}`)
  }, [list, runId])

  // Real decision status for the visible rows (free local reads, one at a time).
  useEffect(() => {
    if (list.s !== 'ok') return
    const todo = missingStatus(list.data, shown, meta)
    if (!todo.length) return
    const c = new AbortController()
    ;(async () => {
      for (const id of todo) {
        if (c.signal.aborted) return
        const doc = await getJson<StoredRunDoc & { target_type?: string }>(`/v1/runs/${encodeURIComponent(id)}`, c.signal).catch(() => null)
        if (c.signal.aborted) return
        setMeta((m) => ({ ...m, [id]: doc ? { status: doc.status, target_type: doc.target_type } : { error: true } }))
      }
    })()
    return () => c.abort()
  }, [list, shown])

  const loadRun = useCallback((id: string) => {
    ctl.current?.abort()                       // cancel the previous request …
    const c = new AbortController(); ctl.current = c
    const token = guard.current.next()         // … and ignore it even if it still resolves
    setRun({ s: 'loading' })
    getJson<StoredRunDoc & { target_type?: string }>(`/v1/runs/${encodeURIComponent(id)}`, c.signal)
      .then((doc) => {
        if (!guard.current.isCurrent(token)) return
        setRun({ s: 'ok', data: doc })
        setMeta((m) => ({ ...m, [doc.run_id]: { status: doc.status, target_type: doc.target_type } }))
      })
      // A cancelled older request is never current, so only real failures (incl. timeouts) show.
      .catch((e) => { if (guard.current.isCurrent(token)) setRun({ s: 'error', err: toErr(e) }) })
  }, [])

  // The URL (#/app/developers/trace/<run_id>) is the single source of the selection.
  useEffect(() => {
    if (!runId) { ctl.current?.abort(); guard.current.next(); setRun({ s: 'idle' }); return }
    setInput(runId)
    const v = checkRunId(runId)
    if (!v.ok) { ctl.current?.abort(); guard.current.next(); setRun({ s: 'idle' }); setInputErr(v.message); return }
    setInputErr(null)
    loadRun(v.id)
  }, [runId, loadRun])
  useEffect(() => () => ctl.current?.abort(), [])

  function select(id: string) { go(`/app/developers/trace/${encodeURIComponent(id)}`) }
  function submit() {
    const v = checkRunId(input)
    if (!v.ok) { setInputErr(v.message); return }     // keep what the user typed
    setInputErr(null)
    if (v.id === runId) loadRun(v.id); else select(v.id)
  }

  const rows = list.s === 'ok' ? list.data : []
  return (
    <div className="inspector ins2">
      <aside className="card pad ins-list" aria-label="Stored runs">
        <div className="card-head">
          <h2 className="h3">Recent runs{list.s === 'ok' && <span className="muted sm"> · {rows.length}</span>}</h2>
          <button className="btn ghost sm" onClick={() => { setMeta({}); loadList() }} disabled={list.s === 'loading'} aria-label="Refresh the run list">↻ Refresh</button>
        </div>
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); submit() }} noValidate>
          <label className="sr" htmlFor="run-id-input">Run ID to inspect</label>
          <input id="run-id-input" value={input} onChange={(e) => { setInput(e.target.value); setInputErr(null) }} placeholder="Paste a run ID"
            aria-invalid={!!inputErr} aria-describedby={inputErr ? 'run-id-err' : 'run-id-hint'} spellCheck={false} autoComplete="off" />
          <button className="btn primary sm" disabled={run.s === 'loading'}>Inspect</button>
        </form>
        {inputErr ? <p className="err-text sm" id="run-id-err" role="alert">{inputErr}</p>
          : <p className="muted xs" id="run-id-hint">Reads stored data only — no search, no credits.</p>}

        {list.s === 'loading' && <ul className="run-rows" aria-busy="true">{[0, 1, 2, 3].map((i) => <li key={i} className="skeleton" />)}</ul>}
        {list.s === 'error' && <ErrorBox err={list.err} onRetry={loadList} />}
        {list.s === 'ok' && rows.length === 0 && (
          <div className="empty-state sm-empty"><p>No stored runs yet. A run is saved each time a request is verified.</p>
            <button className="btn secondary sm" onClick={() => go('/app/playground')}>Run one in the Playground</button></div>
        )}
        {list.s === 'ok' && rows.length > 0 && (
          <>
            <ul className="run-list2">
              {rows.slice(0, shown).map((r) => {
                const m = meta[r.run_id]
                const on = runId === r.run_id
                return (
                  <li key={r.run_id} className={on ? 'on' : ''}>
                    <button className="rl-main" onClick={() => select(r.run_id)} aria-current={on ? 'true' : undefined}>
                      <span className="rl-req">{r.request}</span>
                      <span className="rl-meta">
                        {m && 'status' in m ? <span className={`rl-status ${m.status}`}>{m.status.replace(/_/g, ' ')}</span>
                          : m ? <span className="rl-status unknown">status unavailable</span> : <span className="rl-status loading">status…</span>}
                        <time dateTime={r.created_at}>{new Date(r.created_at).toLocaleString()}</time>
                      </span>
                    </button>
                    <span className="rl-id"><code title={r.run_id}>{shortId(r.run_id)}</code><CopyButton text={r.run_id} label="Copy ID" /></span>
                  </li>
                )
              })}
            </ul>
            {rows.length > shown && <button className="btn ghost sm more" onClick={() => setShown((n) => n + RUNS_PAGE)}>Show {Math.min(RUNS_PAGE, rows.length - shown)} more</button>}
          </>
        )}
      </aside>

      <section className="ins-detail" aria-live="polite" aria-busy={run.s === 'loading'}>
        {run.s === 'idle' && list.s === 'loading' && <div className="card pad loading-row"><span className="spinner" /> Loading recent runs…</div>}
        {run.s === 'idle' && list.s !== 'loading' && !inputErr && rows.length === 0 && (
          <div className="card pad empty-state"><h3>Nothing to inspect yet</h3><p>Once a request has been verified, its run appears here automatically.</p></div>
        )}
        {run.s === 'idle' && inputErr && <div className="card pad"><ErrorBox err={{ kind: 'http', title: 'That run ID can’t be valid', detail: inputErr }} /></div>}
        {run.s === 'loading' && <div className="card pad loading-row"><span className="spinner" /> Loading run {runId}…</div>}
        {run.s === 'error' && (
          <div className="card pad">
            <ErrorBox err={run.err} onRetry={runId ? () => loadRun(runId) : undefined}>
              {rows[0] && rows[0].run_id !== runId && <button className="btn ghost sm" onClick={() => select(rows[0].run_id)}>Open the latest run</button>}
            </ErrorBox>
          </div>
        )}
        {run.s === 'ok' && <RunDetail key={run.data.run_id} doc={run.data} />}
      </section>
    </div>
  )
}

function RunDetail({ doc }: { doc: StoredRunDoc }) {
  const rows = traceRows(doc)
  const counts = statusCounts(rows)
  const reqs = doc.requirements ?? []
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [rawOpen, setRawOpen] = useState(false)
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const { raw_serpapi: raw, ...withoutRaw } = doc as StoredRunDoc & { raw_serpapi?: unknown }
  const sel = doc.selected_candidate
  const selRow = sel ? rows.find((r) => r.candidate_id === sel.candidate_id) : undefined

  return (
    <div className="run-detail">
      <div className="rd-top card pad">
        <div className="rd-head">
          <span className={`rd-status ${doc.status}`}>{doc.status.replace(/_/g, ' ')}</span>
          <span className="rd-meta">
            <code title="Run ID">{doc.run_id}</code><CopyButton text={doc.run_id} label="Copy run ID" />
            {doc.created_at && <time dateTime={doc.created_at}>{new Date(doc.created_at).toLocaleString()}</time>}
            {(doc as StoredRunDoc & { target_type?: string }).target_type && <span className="tag">{(doc as StoredRunDoc & { target_type?: string }).target_type}</span>}
          </span>
        </div>
        <p className="rd-request">{doc.request}</p>
        <p className="rd-explain">{RUN_STATUS_TEXT[doc.status] ?? ''}</p>
      <div className="facts">
        <span><b>{reqs.length}</b> requirement{reqs.length === 1 ? '' : 's'}</span>
        <span><b>{doc.candidate_count ?? rows.length}</b> retrieved</span>
        <span><b>{(doc.ranked_candidates ?? []).length}</b> ranked</span>
        <span><b>{(doc.attempts ?? []).length}</b> checked by Jev</span>
        <span className="vpill ok">{counts.VERIFIED} verified</span>
        <span className="vpill warn">{counts.UNVERIFIED} unverified</span>
        <span className="vpill bad">{counts.REJECTED} rejected</span>
        {counts.NOT_CHECKED > 0 && <span className="vpill idle">{counts.NOT_CHECKED} not checked</span>}
      </div>
      {(doc.errors ?? []).length > 0 && <p className="err-text sm">Run notes: {(doc.errors ?? []).join('; ')}</p>}
      </div>
      <div className="rd-body card pad">

      <h3 className="sub-h">Decision</h3>
      {sel ? (
        <p className="sm"><b>{sel.name || sel.candidate_id}</b> ({sel.candidate_id}) was selected with overall <VerdictPill status={doc.verification?.overall_status ?? selRow?.status ?? 'UNKNOWN'} />
          {doc.status === 'needs_human_review' && ' — returned for review, not labelled verified.'}</p>
      ) : <p className="sm muted">No candidate was selected.</p>}

      <h3 className="sub-h">Requirements ({reqs.length})</h3>
      {reqs.length ? (
        <ul className="req-list">{reqs.map((r) => <li key={r.id}><code>{r.id}</code> {r.description}{r.importance === 'preferred' && <span className="status-tag">preferred</span>}</li>)}</ul>
      ) : <p className="sm muted">No requirements were stored for this run.</p>}

      <div className="rd-cand-head">
        <h3 className="sub-h">Candidates, in ranked order</h3>
        {rows.length > 0 && <span className="rd-toggles">
          <button className="link sm" onClick={() => setOpen(new Set(rows.map((r) => r.candidate_id)))} disabled={open.size === rows.length}>Expand all evidence</button>
          <button className="link sm" onClick={() => setOpen(new Set())} disabled={open.size === 0}>Collapse all</button>
        </span>}
      </div>
      {rows.length === 0 ? <p className="sm muted">This run has no candidates — the search returned nothing to rank or verify.</p> : (
        <>
          <div className="matrix-wrap" tabIndex={0} role="region" aria-label="Verdicts per candidate and requirement">
            <table className="matrix ins-matrix">
              <thead><tr><th scope="col">#</th><th scope="col">Candidate</th>{reqs.map((r) => <th scope="col" key={r.id} title={r.description}>{r.id.replace(/_included$/, '').replace(/_/g, ' ')}</th>)}<th scope="col">Overall</th><th scope="col"><span className="sr">Details</span></th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <RowView key={row.candidate_id} row={row} reqs={reqs} open={open.has(row.candidate_id)}
                    onToggle={() => toggle(row.candidate_id)} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="legend"><span className="cell ok">✓</span> satisfied <span className="cell warn">?</span> unknown <span className="cell bad">✕</span> contradicted <span className="cell">—</span> not checked by Jev (it stops at the first VERIFIED candidate)</p>
        </>
      )}

      <h3 className="sub-h">Underlying data</h3>
      <details className="raw">
        <summary>Stored run JSON <span className="muted sm">(without the raw SerpApi payload)</span></summary>
        <div className="raw-body"><CopyButton text={JSON.stringify(withoutRaw, null, 2)} label="Copy JSON" /><pre tabIndex={0}>{JSON.stringify(withoutRaw, null, 2)}</pre></div>
      </details>
      <details className="raw" onToggle={(e) => setRawOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Raw SerpApi payload {raw == null ? <span className="muted sm">(not stored)</span> : <span className="muted sm">({Math.round(JSON.stringify(raw).length / 1024)} KB)</span>}</summary>
        {rawOpen && raw != null && <div className="raw-body"><pre tabIndex={0}>{JSON.stringify(raw, null, 2)}</pre></div>}
      </details>
      <p className="sm"><a href={`${API_BASE}/v1/runs/${encodeURIComponent(doc.run_id)}/evidence`} target="_blank" rel="noreferrer">Open GET /v1/runs/{doc.run_id}/evidence ↗</a></p>
      </div>
    </div>
  )
}

function fmt(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  return String(v)
}

function RowView({ row, reqs, open, onToggle }: { row: TraceRow; reqs: { id: string; description: string }[]; open: boolean; onToggle: () => void }) {
  const checked = row.status !== 'NOT_CHECKED'
  const ev = row.evidence
  const detailsId = `cand-${row.candidate_id}`
  return (
    <>
      <tr className={row.status === 'REJECTED' ? 'rej' : ''}>
        <td>{row.rank ?? '—'}</td>
        <td className="m-name" title={row.name}>{row.name}<small className="cid">{row.candidate_id}</small></td>
        {reqs.map((r) => {
          const v = row.verdicts[r.id]
          const c = v ? CELL[v.status] : undefined
          const label = v ? (c?.text ?? v.status) : checked ? 'no verdict returned' : 'not checked'
          return <td key={r.id}><span className={'cell ' + (c?.cls ?? '')} title={`${r.description}: ${label}${v?.reason ? ' — ' + v.reason : ''}`}><span aria-hidden>{c?.sym ?? '—'}</span><span className="sr">{label}</span></span></td>
        })}
        <td>{checked ? <VerdictPill status={row.status} /> : <span className="vpill idle">not checked</span>}</td>
        <td><button className="link sm" onClick={onToggle} aria-expanded={open} aria-controls={detailsId}>{open ? 'Hide' : 'Evidence'}</button></td>
      </tr>
      {open && (
        <tr className="ev-row" id={detailsId}>
          <td colSpan={reqs.length + 4}>
            <div className="ev">
              <div>
                <h4>Search evidence</h4>
                {ev ? (
                  <dl>
                    <dt>Price</dt><dd>{fmt(ev.price) ?? 'not provided by the search'}</dd>
                    <dt>Rating</dt><dd>{fmt(ev.rating) ? `${ev.rating}${ev.review_count ? ` (${ev.review_count} reviews)` : ''}` : 'not provided'}</dd>
                    <dt>Location</dt><dd>{fmt(ev.address) ?? fmt(ev.location) ?? 'not provided'}</dd>
                    <dt>Cancellation</dt><dd>{fmt(ev.cancellation_info) ?? 'not provided by the search'}</dd>
                    <dt>Source</dt><dd>{ev.source_url ? <a href={ev.source_url} target="_blank" rel="noreferrer">open listing ↗</a> : 'no link'}</dd>
                  </dl>
                ) : <p className="muted sm">No candidate data was stored for this ID.</p>}
              </div>
              <div>
                <h4>Jev verdicts{row.verifier && <small> · {row.verifier}</small>}</h4>
                {!checked ? <p className="muted sm">Never sent to Jev — verification stops once a candidate is VERIFIED, so lower-ranked candidates are not checked.</p> : (
                  <ul className="verdict-list">
                    {reqs.map((r) => {
                      const v = row.verdicts[r.id]
                      return (
                        <li key={r.id}>
                          {v ? <VerdictPill status={v.status} /> : <span className="vpill idle">no verdict</span>}
                          <span><b>{r.description}</b>{v?.reason && <small>{v.reason}</small>}</span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
