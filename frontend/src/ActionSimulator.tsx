import { useEffect, useState } from 'react'
import BookingSimulator from './BookingSimulator'
import { apiFetch } from './api'
import OrderSimulator, { type OrderContext } from './OrderSimulator'

/* Picks the simulated action for ONE candidate, as classified by the backend from the
   search engine that produced it (GET …/action-context). Add a new action type by adding
   a component and one branch below — the hotel BookingSimulator stays untouched. */

type Req = { requirement_id: string; description: string; status: string }
type ReviewContext = {
  target_type: string
  action: { kind: string; label: string; supported: boolean }
  run_id: string; candidate_id: string
  item: { name: string | null; source_url: string | null; engine: string | null }
  verification_status: string
  unresolved_requirements: Req[]; contradicted_requirements: Req[]
  message: string
}
type Ctx = { target_type: string } & Record<string, unknown>

export default function ActionSimulator({ runId, candidateId, onClose }: { runId: string; candidateId: string; onClose: () => void }) {
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    apiFetch(`/v1/runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(candidateId)}/action-context`, { signal: ctl.signal })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(typeof j.detail === 'object' ? j.detail.message : j.detail || `HTTP ${r.status}`)
        setCtx(j as Ctx)
      })
      .catch((e: Error) => { if (!ctl.signal.aborted) setErr(e.message || 'Could not load this result.') })
    return () => ctl.abort()
  }, [runId, candidateId])

  if (ctx?.target_type === 'hotel') return <BookingSimulator runId={runId} candidateId={candidateId} onClose={onClose} />
  if (ctx?.target_type === 'product') return <OrderSimulator ctx={ctx as unknown as OrderContext} onClose={onClose} />
  // place / generic / anything new: review only — never a hotel booking
  const review = ctx ? (ctx as unknown as ReviewContext) : null

  return (
    <div className="bk-overlay" role="dialog" aria-modal="true" aria-label="Review result" onClick={onClose}>
      <div className="bk-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bk-banner neutral">REVIEW ONLY — NO ACTION IS SIMULATED FOR THIS RESULT</div>
        <button className="bk-close" onClick={onClose} aria-label="Close">×</button>
        {!ctx && !err && <p className="bk-pad"><span className="spinner" /> Checking which action fits this result…</p>}
        {err && <div className="bk-pad"><h3>Could not open this result</h3><p className="err-text">{err}</p><div className="bk-actions"><button className="bk-btn ghost" onClick={onClose}>Close</button></div></div>}
        {review && (
          <div className="bk-pad">
            <h3>{review.item.name ?? review.candidate_id}</h3>
            <p className="muted sm">candidate {review.candidate_id} · run {review.run_id} · source {review.item.engine ?? 'unknown'}</p>
            <p>{review.message}</p>
            <p className="sm">Jev status: <span className={`vpill ${review.verification_status === 'VERIFIED' ? 'ok' : review.verification_status === 'REJECTED' ? 'bad' : 'warn'}`}>{review.verification_status.replace('_', ' ')}</span></p>
            {[...review.contradicted_requirements, ...review.unresolved_requirements].length > 0 && (
              <ul className="flag-list">
                {[...review.contradicted_requirements, ...review.unresolved_requirements].map((r) => (
                  <li key={r.requirement_id + r.status}><span className={`vpill ${r.status === 'CONTRADICTED' ? 'bad' : 'warn'}`}>{r.status}</span> {r.description}</li>
                ))}
              </ul>
            )}
            <div className="bk-actions">
              {review.item.source_url && <a className="bk-btn ghost" href={review.item.source_url} target="_blank" rel="noreferrer">Open source ↗</a>}
              <button className="bk-btn" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
