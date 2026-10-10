/* Verification trace UI shared by the Assistant and the Playground.
   Pure presentation of real backend events — nothing here invents a status. */
import { createContext, useContext } from 'react'
import type { CandItem, TraceState } from './chat'
import { rankReasonFor, verdictForCandidate } from './traceEvents'

export function candId(c: CandItem): string {
  return String(c.candidate_id ?? c.id ?? c.name ?? c.title ?? 'candidate')
}
export function candName(c: CandItem): string {
  return String(c.candidate_name ?? c.name ?? c.title ?? candId(c))
}
export function candUrl(c: CandItem): string | null {
  const u = c.source_url ?? c.url ?? c.link
  return typeof u === 'string' && u ? u : null
}
export function fmtVal(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined || v === '') return null
  return String(v)
}
export function verdictClass(s: string): 'ok' | 'bad' | 'warn' {
  const t = s.toUpperCase()
  if (t === 'SATISFIED' || t === 'VERIFIED') return 'ok'
  if (t === 'CONTRADICTED' || t === 'REJECTED') return 'bad'
  return 'warn'
}

/* ---------- booking simulator entry (demo only): opened by candidate_id + run_id ---------- */
export type BookTarget = { runId: string; candidateId: string }
export const BookContext = createContext<(t: BookTarget) => void>(() => {})

export function BookButton({ runId, candidateId, status }: { runId: string | null | undefined; candidateId: string; status: string }) {
  const open = useContext(BookContext)
  if (!runId || !candidateId) return null
  const s = status.toUpperCase()
  if (s === 'REJECTED') return <button className="bk-open" disabled title="Jev contradicted a required point">Rejected — not bookable</button>
  return (
    <button className={'bk-open' + (s === 'VERIFIED' ? '' : ' warn')} onClick={() => open({ runId, candidateId })}>
      {s === 'VERIFIED' ? 'Simulate booking' : 'Simulate booking (needs review)'}
    </button>
  )
}

export function VerdictPill({ status }: { status: string }) {
  return <span className={`vpill ${verdictClass(status)}`}>{status}</span>
}

/* ================= trace timeline ================= */
export function TraceView({ trace, onToggle }: { trace: TraceState; onToggle: () => void }) {
  const hasAnything =
    trace.routeNote || trace.requirements.length > 0 || trace.engine ||
    (trace.candidateCount ?? null) !== null || trace.ranked.length > 0 ||
    trace.verdicts.length > 0 || trace.final || trace.error
  if (!hasAnything && !trace.statusLine) return null
  const verdictFor = (id: string) => verdictForCandidate(trace.verdicts, id)

  return (
    <div className="trace">
      <button className="trace-head" onClick={onToggle} aria-expanded={trace.open}>
        <span className="trace-title"><span className="trace-ico" aria-hidden>◎</span> How I verified this</span>
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
              <BookButton runId={trace.final?.run_id} candidateId={v.candidate_id} status={v.overall_status} />
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

export function FinalCard({ fin }: { fin: NonNullable<TraceState['final']> }) {
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
        <BookButton runId={fin.run_id} candidateId={candId(c)} status={vover || 'VERIFIED'} />
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
        <BookButton runId={fin.run_id} candidateId={candId(c)} status={vover || 'UNVERIFIED'} />
      </div>
    )
  }
  if (st === 'no_verified_match' || st === 'error') {
    return (
      <div className="final plain">
        <span className="final-badge plain">○ NO VERIFIED MATCH</span>
        <p>The search returned nothing ProofGate could select. Nothing is labelled verified.</p>
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
