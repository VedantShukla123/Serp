/* Pure helpers for SSE trace events (no React) so they can be unit-tested
   with `node --test`. Backend contract: app/services/pipeline.py _emit calls. */

export type RankedItem = { candidate_id?: string; id?: string; rank?: number; reason?: string; name?: string }
export type ReqItem = { id: string; description: string }
type NamedCand = { candidate_id?: string; id?: string; name?: string; candidate_name?: string; title?: string }

/** `ranking` event: backend sends `ranked_candidates` ({candidate_id, rank, reason}).
 *  Names come from the earlier `candidates` event. */
export function rankedFromEvent(p: Record<string, unknown>, candidates: NamedCand[]): RankedItem[] {
  const raw = Array.isArray(p.ranked_candidates) ? p.ranked_candidates : Array.isArray(p.ranked) ? p.ranked : []
  return (raw as RankedItem[]).map((r) => {
    if (r.name) return r
    const c = candidates.find((x) => (x.candidate_id ?? x.id) === (r.candidate_id ?? r.id))
    const name = c ? (c.candidate_name ?? c.name ?? c.title) : undefined
    return name ? { ...r, name } : r
  })
}

/** Text shown for a ranked shortlist row, derived only from the Jev status (the
 *  `reason` field in events is ignored, it may be stale or from an older backend).
 *  Wording matches app/services/rank_reasons.py. */
export function rankReasonFor(overallStatus: string | undefined): string {
  switch ((overallStatus ?? '').toUpperCase()) {
    case 'VERIFIED':
      return 'Ranked as a relevant candidate; all required points verified.'
    case 'REJECTED':
      return 'Ranked as a relevant candidate; rejected because at least one required point was contradicted.'
    case 'UNVERIFIED':
      return 'Ranked as a relevant candidate; some required points remain unverified.'
    default:
      return 'Ranked as a relevant candidate; not yet verified.'
  }
}

/** `verdict` events come in two shapes: per-candidate ({candidate_id, overall_status,
 *  requirements}) and run-level ({status, run_id, selected_candidate_id, attempts}).
 *  Only the per-candidate shape belongs in the trace as a candidate row. */
export function isCandidateVerdict(p: Record<string, unknown>): boolean {
  return typeof p.candidate_id === 'string' && p.candidate_id !== ''
}

/** `requirements` event item -> chip. Renders exactly what the backend parser produced. */
export function normReq(r: unknown, i: number): ReqItem {
  if (typeof r === 'string') return { id: `R${i + 1}`, description: r }
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>
    return {
      id: String(o.id ?? o.requirement_id ?? `R${i + 1}`),
      description: String(o.description ?? o.requirement ?? o.text ?? JSON.stringify(r)),
    }
  }
  return { id: `R${i + 1}`, description: String(r) }
}

/** Verdict for a candidate, matched by candidate_id (never by array position or rank). */
export function verdictForCandidate<V extends { candidate_id: string }>(verdicts: V[], id: string): V | undefined {
  return verdicts.find((v) => v.candidate_id === id)
}
