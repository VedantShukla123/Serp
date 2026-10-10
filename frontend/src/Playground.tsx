import { useEffect, useMemo, useRef, useState } from 'react'
import Composer from './Composer'
import { EXAMPLES } from './Assistant'
import { BookButton, TraceView, VerdictPill } from './Trace'
import type { ChatMsg, useAgentChat } from './chat'
import { apiFetch } from './api'
import { buildCards, journey, priceLabel, summarize, type CandidateCard, type Cond } from './playgroundView'

/* Playground: one request → one clear decision. Every status, count and reason below is
   derived from events the backend actually sent (live SSE or a stored run), joined by
   candidate_id. Technical detail is kept, but collapsed until asked for. */

const STATUS_TEXT: Record<CandidateCard['status'], string> = {
  VERIFIED: 'Verified', UNVERIFIED: 'Needs review', REJECTED: 'Rejected', CHECKING: 'Checking…', NOT_CHECKED: 'Not checked', PENDING: 'Waiting',
}
const COND_ICON: Record<Cond['status'], string> = { SATISFIED: '✓', UNKNOWN: '?', CONTRADICTED: '✕', NO_VERDICT: '—' }
const COND_CLS: Record<Cond['status'], string> = { SATISFIED: 'ok', UNKNOWN: 'warn', CONTRADICTED: 'bad', NO_VERDICT: '' }
const COND_TEXT: Record<Cond['status'], string> = { SATISFIED: 'satisfied', UNKNOWN: 'unknown', CONTRADICTED: 'contradicted', NO_VERDICT: 'no verdict' }

function statusCls(s: CandidateCard['status']) {
  return s === 'VERIFIED' ? 'ok' : s === 'REJECTED' ? 'bad' : s === 'UNVERIFIED' ? 'warn' : 'idle'
}

function StatusChip({ s }: { s: CandidateCard['status'] }) {
  return <span className={`vpill ${statusCls(s)}`}>{s === 'CHECKING' && <span className="spinner xs" />}{STATUS_TEXT[s]}</span>
}

/** The few conditions worth seeing first: contradicted, then unknown, then satisfied. */
function keyConditions(c: CandidateCard, n = 3): Cond[] {
  const rank = { CONTRADICTED: 0, UNKNOWN: 1, SATISFIED: 2, NO_VERDICT: 3 }
  return [...c.conditions].filter((x) => x.status !== 'NO_VERDICT').sort((a, b) => rank[a.status] - rank[b.status]).slice(0, n)
}

function CondList({ conds, reasons }: { conds: Cond[]; reasons?: boolean }) {
  return (
    <ul className="conds">
      {conds.map((c) => (
        <li key={c.id} className={COND_CLS[c.status]}>
          <span className="cond-ico" aria-hidden>{COND_ICON[c.status]}</span>
          <span className="cond-txt">{c.label}<span className="sr"> — {COND_TEXT[c.status]}</span>{reasons && c.reason && <small>{c.reason}</small>}</span>
        </li>
      ))}
    </ul>
  )
}

export default function Playground({ chat }: { chat: ReturnType<typeof useAgentChat> }) {
  const { messages, sending, send, loadReplay, patchTrace } = chat
  const [input, setInput] = useState('')
  const [stored, setStored] = useState<{ run_id: string; request: string }[]>([])
  const [replayId, setReplayId] = useState('')
  const [replayErr, setReplayErr] = useState<string | null>(null)
  const [replaying, setReplaying] = useState(false)
  const [pick, setPick] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const ctl = new AbortController()
    apiFetch('/v1/runs?limit=10', { signal: ctl.signal }).then((r) => (r.ok ? r.json() : [])).then((rows) => {
      if (Array.isArray(rows)) { setStored(rows); if (rows[0]) setReplayId(rows[0].run_id) }
    }).catch(() => setStored([]))
    return () => ctl.abort()
  }, [])

  const runs = messages.filter((m): m is ChatMsg & { trace: NonNullable<ChatMsg['trace']> } => m.role === 'agent' && !!m.trace)
  const idx = pick ?? runs.length - 1
  const run = runs[idx] ?? null
  const request = run ? messages[messages.indexOf(run) - 1]?.text ?? null : null
  const t = run?.trace ?? null
  const live = !!run?.live
  const targetType = t?.final?.target_type ?? null

  const cards = useMemo(() => (t ? buildCards(t) : []), [t])
  const summary = useMemo(() => summarize(t, cards, live), [t, cards, live])
  const steps = journey(t, live)

  // New run → clear the manual selection so the panel follows the backend's pick.
  useEffect(() => { setSelected(null); setExpanded(null) }, [run?.id])
  const current = cards.find((c) => c.candidate_id === (selected ?? summary?.focus)) ?? cards[0] ?? null

  function submit() {
    if (!input.trim() || sending) return
    setPick(null)
    void send(input)
  }

  function replay() {
    if (!replayId || replaying || sending) return
    setReplaying(true); setReplayErr(null)
    apiFetch(`/v1/runs/${encodeURIComponent(replayId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 404 ? 'run not found' : `HTTP ${r.status}`))))
      .then((doc) => { setPick(null); loadReplay(doc) })
      .catch((e: Error) => setReplayErr(`Could not load that run (${e.message}).`))
      .finally(() => setReplaying(false))
  }

  function choose(id: string) {
    setSelected(id)
    if (window.innerWidth < 1080) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  return (
    <div className="page-scroll">
      <div className="pg-page playground pg2 enter">
        {/* ---------- A. request composer ---------- */}
        <section className={'card pad ask' + (t ? ' compact' : '')}>
          <div className="ask-head">
            {!t && <span className="eyebrow">Playground</span>}
            <h1>What would you like to do?</h1>
            {!t && <p className="muted">Describe an action with its must-haves. ProofGate checks each one against live evidence before anything proceeds.</p>}
          </div>
          <Composer size="lg" value={input} onChange={setInput} onSubmit={submit} disabled={sending}
            placeholder="e.g. a hotel in Goa under Rs 10,000 for 2, beachfront, free cancellation" />
          <div className="ask-row">
            <span className="muted sm">Try:</span>
            {EXAMPLES.slice(0, 2).map((ex) => (
              <button key={ex} className="chip sm" onClick={() => setInput(ex)} title={ex}>{ex.length > 54 ? ex.slice(0, 52) + '…' : ex}</button>
            ))}
            <span className="cost-note"><span className="dot" aria-hidden />Send runs a live search · uses API credits</span>
          </div>
          <div className="replay-row">
            <span className="replay-title">Or replay a stored run <span className="free">no new search · no credits</span></span>
            {stored.length > 0 ? (
              <>
                <label className="sr" htmlFor="replay-select">Stored run</label>
                <select id="replay-select" value={replayId} onChange={(e) => setReplayId(e.target.value)}>
                  {stored.map((r) => <option key={r.run_id} value={r.run_id}>{r.run_id} · {r.request.slice(0, 44)}{r.request.length > 44 ? '…' : ''}</option>)}
                </select>
                <button className="btn secondary sm" onClick={replay} disabled={replaying || sending}>{replaying ? 'Loading…' : 'Replay'}</button>
              </>
            ) : <span className="muted sm">No stored runs yet.</span>}
            {runs.length > 1 && (
              <label className="run-pick">Showing
                <select value={idx} onChange={(e) => setPick(Number(e.target.value))}>
                  {runs.map((r, i) => <option key={r.id} value={i}>#{i + 1} {r.replay ? 'replay' : 'live'} · {r.runId ?? (r.live ? 'running…' : 'no run id')}</option>)}
                </select>
              </label>
            )}
          </div>
          {replayErr && <p className="err-text sm" role="alert">{replayErr}</p>}
        </section>

        {!t && (
          <section className="card pad empty-state">
            <div className="empty-ico" aria-hidden>◎</div>
            <h3>Nothing to show yet</h3>
            <p>Send a request, or replay a stored run. Results appear only from real backend data — nothing here is a sample.</p>
          </section>
        )}

        {t && (
          <>
            {/* ---------- request echo + B. slim progress ---------- */}
            <section className="card run-bar enter" aria-label="Your request and progress">
              <div className="run-req">
                <span className="run-label">Your request</span>
                <p>{request}</p>
                <span className="run-tags">
                  <span className={'status-tag' + (run?.replay ? '' : ' live')}>{run?.replay ? 'Stored run · replay' : live ? 'Live · running' : 'Live run'}</span>
                  {run?.runId && <code className="tag">run {run.runId}</code>}
                </span>
              </div>
              <ol className="journey" aria-label="Verification progress">
                {steps.map((s) => (
                  <li key={s.id} className={s.state} aria-current={s.state === 'active' ? 'step' : undefined}>
                    <span className="j-dot" aria-hidden>{s.state === 'done' ? '✓' : s.state === 'error' ? '!' : ''}</span>
                    <span className="j-txt"><b>{s.label}</b><small>{s.state === 'active' ? 'in progress…' : s.state === 'error' ? 'failed' : s.state === 'skipped' ? 'not reached' : s.detail || ' '}</small></span>
                  </li>
                ))}
              </ol>
            </section>

            {/* ---------- C. the one decision summary ---------- */}
            {summary && (
              <section className={`decision ${summary.tone} enter`} aria-live="polite">
                <div className="decision-main">
                  <span className="decision-ico" aria-hidden>{summary.tone === 'ok' ? '✓' : summary.tone === 'warn' ? '◷' : summary.tone === 'bad' ? '✕' : summary.tone === 'live' ? '' : '○'}{summary.tone === 'live' && <span className="spinner" />}</span>
                  <div>
                    <h2>{summary.title}</h2>
                    <p>{summary.body}</p>
                    <p className="next"><b>Next:</b> {summary.next}</p>
                  </div>
                </div>
                {summary.counts && (
                  <dl className="counts" aria-label="Jev results">
                    <div className="ok"><dt>Verified</dt><dd>{summary.counts.VERIFIED}</dd></div>
                    <div className="warn"><dt>Needs review</dt><dd>{summary.counts.UNVERIFIED}</dd></div>
                    <div className="bad"><dt>Rejected</dt><dd>{summary.counts.REJECTED}</dd></div>
                  </dl>
                )}
              </section>
            )}

            {/* ---------- D. shortlist + E. selected candidate ---------- */}
            {cards.length > 0 && (
              <div className="results">
                <section className="shortlist" aria-label="Candidates in ranked order">
                  <div className="list-head"><h2 className="h3">Options, best ranked first</h2><span className="muted sm">{cards.length}{t.candidateCount !== null && t.candidateCount !== cards.length ? ` of ${t.candidateCount}` : ''}</span></div>
                  <ul className="cand-list">
                    {cards.map((c) => {
                      const isSel = current?.candidate_id === c.candidate_id
                      const open = expanded === c.candidate_id
                      return (
                        <li key={c.candidate_id} className={`cand ${statusCls(c.status)}${isSel ? ' sel' : ''}`}>
                          <button className="cand-main" onClick={() => choose(c.candidate_id)} aria-pressed={isSel}>
                            <span className="cand-rank">{c.rank ?? '–'}</span>
                            <span className="cand-body">
                              <span className="cand-top"><span className="cand-name">{c.name}</span><StatusChip s={c.status} /></span>
                              <span className="cand-meta">{c.price ? <><b>{c.price}</b> <small>{priceLabel(targetType)}</small></> : <small>Price unknown</small>}{c.seller && <small> · {c.seller}</small>}</span>
                              <span className="cand-why">{c.explanation}</span>
                            </span>
                          </button>
                          {c.conditions.some((x) => x.status !== 'NO_VERDICT') && (
                            <div className="cand-foot">
                              <CondList conds={open ? c.conditions : keyConditions(c)} reasons={open} />
                              <button className="link sm" onClick={() => setExpanded(open ? null : c.candidate_id)} aria-expanded={open}>
                                {open ? 'Show less' : `All ${c.conditions.length} conditions`}
                              </button>
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </section>

                {current && (
                  <aside className="card pad sel-panel enter" ref={panelRef} key={current.candidate_id} aria-label="Selected option">
                    <span className="sel-kicker">{current.candidate_id === summary?.focus ? 'ProofGate’s pick' : 'Selected option'}{current.rank ? ` · ranked #${current.rank}` : ''}</span>
                    <h2 className="sel-name">{current.name}</h2>
                    <div className="sel-meta">
                      <StatusChip s={current.status} />
                      {current.price ? <span><b>{current.price}</b> <small>{priceLabel(targetType)}</small></span> : <small>Price unknown</small>}
                      {current.url && <a href={current.url} target="_blank" rel="noreferrer">listing ↗</a>}
                    </div>
                    <h3 className="sub-h">Why this result?</h3>
                    <p className="sel-why">{current.explanation}</p>
                    {(['CONTRADICTED', 'UNKNOWN', 'SATISFIED'] as const).map((st) => {
                      const list = current.conditions.filter((x) => x.status === st)
                      if (!list.length) return null
                      return (
                        <div key={st} className="sel-group">
                          <span className={`grp ${COND_CLS[st]}`}>{st === 'CONTRADICTED' ? 'Contradicted' : st === 'UNKNOWN' ? 'Not confirmed' : 'Confirmed'} ({list.length})</span>
                          <CondList conds={list} reasons />
                        </div>
                      )
                    })}
                    <div className="sel-action">
                      <BookButton runId={t.final?.run_id} candidateId={current.candidate_id} status={current.status === 'REJECTED' ? 'REJECTED' : current.status === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED'} targetType={targetType} />
                      <p className="muted sm">
                        {current.status === 'REJECTED' ? 'Rejected options cannot proceed.'
                          : current.status === 'VERIFIED' ? 'Opens a simulated action — nothing real is booked or bought.'
                          : current.status === 'UNVERIFIED' ? 'You’ll be asked to acknowledge the unconfirmed conditions first. Simulated only.'
                          : 'Jev has not checked this option, so it is treated as unverified.'}
                      </p>
                    </div>
                  </aside>
                )}
              </div>
            )}

            {/* ---------- technical details, on demand ---------- */}
            <section className="tech" aria-label="Technical details">
              {t.verdicts.length > 0 && (
                <details className="tech-item">
                  <summary>Requirement verification <span className="muted sm">every option × every condition</span></summary>
                  <div className="tech-body matrix-wrap">
                    <table className="matrix">
                      <thead><tr><th scope="col">Option</th>{t.requirements.map((r) => <th scope="col" key={r.id} title={r.description}>{r.id.replace(/_included$/, '').replace(/_/g, ' ')}</th>)}<th scope="col">Overall</th></tr></thead>
                      <tbody>
                        {cards.filter((c) => c.status !== 'NOT_CHECKED' && c.status !== 'PENDING' && c.status !== 'CHECKING').map((c) => (
                          <tr key={c.candidate_id}>
                            <td className="m-name" title={c.name}>{c.name}</td>
                            {c.conditions.map((x) => <td key={x.id}><span className={`cell ${COND_CLS[x.status]}`} title={`${x.label}: ${COND_TEXT[x.status]}${x.reason ? ' — ' + x.reason : ''}`}><span aria-hidden>{COND_ICON[x.status]}</span><span className="sr">{COND_TEXT[x.status]}</span></span></td>)}
                            <td><VerdictPill status={c.status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="legend"><span className="cell ok">✓</span> satisfied <span className="cell warn">?</span> unknown <span className="cell bad">✕</span> contradicted</p>
                  </div>
                </details>
              )}
              <details className="tech-item">
                <summary>Evidence and Jev trace <span className="muted sm">step-by-step events</span></summary>
                <div className="tech-body">
                  {t.requirements.length > 0 && <p className="sm"><b>Requirements parsed:</b> {t.requirements.map((r) => r.description).join(' · ')}</p>}
                  <TraceView trace={{ ...t, open: true }} onToggle={() => run && patchTrace(run.id, (x) => ({ ...x, open: !x.open }))} />
                </div>
              </details>
              {run && !run.live && run.text && (
                <details className="tech-item">
                  <summary>Full agent response <span className="muted sm">{run.replay ? 'replay note' : 'as written by the agent, unedited'}</span></summary>
                  <div className="tech-body"><p className="reply full-reply">{run.text}</p></div>
                </details>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
