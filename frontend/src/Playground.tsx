import { useEffect, useMemo, useRef, useState } from 'react'
import Composer from './Composer'
import { EXAMPLES } from './Assistant'
import { BookButton, TraceView, VerdictPill } from './Trace'
import type { ChatMsg, useAgentChat } from './chat'
import { buildCards, condTally, decisionHeading, journey, priceLabel, summarize, type CandidateCard, type Cond } from './playgroundView'

/* Playground: one request → one clear decision. Every status, count and reason below is
   derived from events the backend actually sent, joined by candidate_id. Stored runs stay
   available in the Developer Hub; technical detail is kept here, collapsed until asked for. */

const STATUS_TEXT: Record<CandidateCard['status'], string> = {
  VERIFIED: 'Verified', UNVERIFIED: 'Needs review', REJECTED: 'Rejected', CHECKING: 'Checking…', NOT_CHECKED: 'Not checked', PENDING: 'Waiting',
}
const COND_ICON: Record<Cond['status'], string> = { SATISFIED: '✓', UNKNOWN: '?', CONTRADICTED: '✕', NO_VERDICT: '—' }
const COND_CLS: Record<Cond['status'], string> = { SATISFIED: 'ok', UNKNOWN: 'warn', CONTRADICTED: 'bad', NO_VERDICT: '' }
const COND_TEXT: Record<Cond['status'], string> = { SATISFIED: 'satisfied', UNKNOWN: 'unknown', CONTRADICTED: 'contradicted', NO_VERDICT: 'no verdict' }
const GROUP_TEXT = { CONTRADICTED: 'Didn’t match', UNKNOWN: 'Couldn’t be confirmed', SATISFIED: 'Confirmed by evidence' } as const

function statusCls(s: CandidateCard['status']) {
  return s === 'VERIFIED' ? 'ok' : s === 'REJECTED' ? 'bad' : s === 'UNVERIFIED' ? 'warn' : 'idle'
}

function StatusChip({ s }: { s: CandidateCard['status'] }) {
  return <span className={`vpill ${statusCls(s)}`}>{s === 'CHECKING' && <span className="spinner xs" />}{STATUS_TEXT[s]}</span>
}

function CondList({ conds }: { conds: Cond[] }) {
  return (
    <ul className="conds">
      {conds.map((c) => (
        <li key={c.id} className={COND_CLS[c.status]}>
          <span className="cond-ico" aria-hidden>{COND_ICON[c.status]}</span>
          <span className="cond-txt">{c.label}<span className="sr"> — {COND_TEXT[c.status]}</span>{c.reason && <small>{c.reason}</small>}</span>
        </li>
      ))}
    </ul>
  )
}

export default function Playground({ chat }: { chat: ReturnType<typeof useAgentChat> }) {
  const { messages, sending, send, patchTrace } = chat
  const [input, setInput] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)

  // Always show the latest run of this session.
  const run = [...messages].reverse().find((m): m is ChatMsg & { trace: NonNullable<ChatMsg['trace']> } => m.role === 'agent' && !!m.trace) ?? null
  const request = run ? messages[messages.indexOf(run) - 1]?.text ?? null : null
  const t = run?.trace ?? null
  const live = !!run?.live
  const targetType = t?.final?.target_type ?? null

  const cards = useMemo(() => (t ? buildCards(t) : []), [t])
  const summary = useMemo(() => summarize(t, cards, live), [t, cards, live])
  const steps = journey(t, live)

  // New run → clear the manual selection so the panel follows the backend's pick.
  useEffect(() => { setSelected(null) }, [run?.id])
  const current = cards.find((c) => c.candidate_id === (selected ?? summary?.focus)) ?? cards[0] ?? null

  function submit() {
    if (!input.trim() || sending) return
    void send(input)
  }

  function choose(id: string) {
    setSelected(id)
    if (window.innerWidth < 1080) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  return (
    <div className="page-scroll">
      <div className="pg-page playground pg2 enter">
        {/* ---------- search ---------- */}
        <section className={'card pad ask' + (t ? ' compact' : '')}>
          <h1 className="ask-title">What would you like to do?</h1>
          <Composer size="lg" value={input} onChange={setInput} onSubmit={submit} disabled={sending}
            placeholder="e.g. a hotel in Goa under Rs 10,000 for 2, beachfront, free cancellation" />
          <div className="ask-row">
            {EXAMPLES.slice(0, 2).map((ex) => (
              <button key={ex} className="chip sm" onClick={() => setInput(ex)} title={ex}>{ex.length > 54 ? ex.slice(0, 52) + '…' : ex}</button>
            ))}
            <span className="cost-note">Each search runs live and uses API credits</span>
          </div>
        </section>

        {!t && (
          <section className="empty-state">
            <div className="empty-ico" aria-hidden>◎</div>
            <h3>Start with a request</h3>
            <p>Describe what you need and your must-haves, or try a suggestion above. ProofGate searches, checks each requirement against evidence, and tells you which options are verified.</p>
          </section>
        )}

        {t && (
          <>
            {/* ---------- request + progress ---------- */}
            <section className="run-bar enter" aria-label="Your request and progress">
              <p className="run-req" title={request ?? undefined}>{request}</p>
              <ol className="journey" aria-label="Verification progress">
                {steps.map((s) => (
                  <li key={s.id} className={s.state} aria-current={s.state === 'active' ? 'step' : undefined}>
                    <span className="j-dot" aria-hidden>{s.state === 'done' ? '✓' : s.state === 'error' ? '!' : ''}</span>
                    <span className="j-txt">{s.label}<span className="sr"> — {s.state === 'active' ? 'in progress' : s.state === 'error' ? 'failed' : s.state === 'skipped' ? 'not reached' : s.state === 'done' ? 'done' : 'waiting'}</span></span>
                  </li>
                ))}
              </ol>
            </section>

            {/* ---------- the decision ---------- */}
            {summary && (
              <section className={`decision ${summary.tone} enter`} aria-live="polite">
                <span className="decision-ico" aria-hidden>{summary.tone === 'ok' ? '✓' : summary.tone === 'warn' ? '!' : summary.tone === 'bad' ? '✕' : summary.tone === 'live' ? '' : '○'}{summary.tone === 'live' && <span className="spinner" />}</span>
                <div className="decision-text">
                  <h2>{decisionHeading(summary, cards)}</h2>
                  <p>{summary.body}</p>
                  <p className="next">{summary.next}</p>
                  {summary.counts && (
                    <p className="counts" aria-label="Verification results">
                      <span className="ok">{summary.counts.VERIFIED} verified</span>
                      <span className="warn">{summary.counts.UNVERIFIED} need review</span>
                      <span className="bad">{summary.counts.REJECTED} rejected</span>
                    </p>
                  )}
                </div>
              </section>
            )}

            {/* ---------- options + selected option ---------- */}
            {cards.length > 0 && (
              <div className="results">
                <section className="shortlist" aria-label="Options in ranked order">
                  <h2 className="list-head">Options <span>{cards.length}{t.candidateCount !== null && t.candidateCount !== cards.length ? ` of ${t.candidateCount}` : ''}, best first</span></h2>
                  <ul className="cand-list">
                    {cards.map((c) => {
                      const isSel = current?.candidate_id === c.candidate_id
                      const tally = condTally(c)
                      return (
                        <li key={c.candidate_id} className={`cand ${statusCls(c.status)}${isSel ? ' sel' : ''}`}>
                          <button className="cand-main" onClick={() => choose(c.candidate_id)} aria-pressed={isSel}>
                            <span className="cand-rank">{c.rank ?? '–'}</span>
                            <span className="cand-body">
                              <span className="cand-top"><span className="cand-name">{c.name}</span><StatusChip s={c.status} /></span>
                              <span className="cand-meta">
                                {c.price ? <b>{c.price}</b> : <span>Price unknown</span>}
                                {c.seller && <span> · {c.seller}</span>}
                                {tally && <span className="cand-tally"> · {tally}</span>}
                              </span>
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>

                {current && (
                  <aside className="card pad sel-panel enter" ref={panelRef} key={current.candidate_id} aria-label="Selected option">
                    <span className="sel-kicker">{current.candidate_id === summary?.focus ? 'ProofGate’s pick' : 'Selected option'}{current.rank ? ` · #${current.rank}` : ''}</span>
                    <h2 className="sel-name">{current.name}</h2>
                    <div className="sel-meta">
                      <StatusChip s={current.status} />
                      {current.price ? <span><b>{current.price}</b> <small>{priceLabel(targetType)}</small></span> : <small>Price unknown</small>}
                      {current.url && <a href={current.url} target="_blank" rel="noreferrer">View listing ↗</a>}
                    </div>
                    <p className="sel-why">{current.explanation}</p>
                    {(['CONTRADICTED', 'UNKNOWN', 'SATISFIED'] as const).map((st) => {
                      const list = current.conditions.filter((x) => x.status === st)
                      if (!list.length) return null
                      return (
                        <div key={st} className="sel-group">
                          <h3 className={`grp ${COND_CLS[st]}`}>{GROUP_TEXT[st]} ({list.length})</h3>
                          <CondList conds={list} />
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
            <details className="tech">
              <summary>Technical details{run?.runId ? <span className="muted sm"> · run {run.runId}</span> : null}</summary>
              <div className="tech-body">
                {t.verdicts.length > 0 && (
                  <>
                    <h3 className="sub-h">Every option × every requirement</h3>
                    <div className="matrix-wrap">
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
                  </>
                )}
                <h3 className="sub-h">Evidence and Jev trace</h3>
                {t.requirements.length > 0 && <p className="sm"><b>Requirements parsed:</b> {t.requirements.map((r) => r.description).join(' · ')}</p>}
                <TraceView trace={{ ...t, open: true }} onToggle={() => run && patchTrace(run.id, (x) => ({ ...x, open: !x.open }))} />
                {run && !run.live && run.text && (
                  <>
                    <h3 className="sub-h">Full agent response</h3>
                    <p className="reply full-reply">{run.text}</p>
                  </>
                )}
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  )
}
