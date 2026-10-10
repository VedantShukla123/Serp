import { targetTypeOf } from './actionTypes.ts'

/* Stored run (GET /v1/runs/{run_id}) -> trace state, so the Playground can replay a
   real past run without a new search. Pure: every value comes from the stored record. */

type StoredReq = { id: string; description?: string }
type StoredVerdict = { requirement_id: string; status: string; reason?: string }
type StoredAttempt = { candidate_id: string; candidate_name?: string; verification: { overall_status: string; requirements: StoredVerdict[] } }
type StoredCand = { candidate_id: string; name?: string; title?: string; price?: unknown; rating?: unknown; source_url?: string; seller?: string }
export type StoredRun = {
  run_id: string; status: string; request: string; candidate_count?: number
  requirements?: StoredReq[]; candidates?: StoredCand[]
  ranked_candidates?: { candidate_id: string; rank: number; reason?: string }[]
  attempts?: StoredAttempt[]
  selected_candidate?: StoredCand | null
  verification?: { overall_status: string; requirements: StoredVerdict[] } | null
  serpapi_meta?: { engine?: string }
  action?: string
  target_type?: string | null
}

export function traceFromRun(r: StoredRun) {
  const names = new Map((r.candidates ?? []).map((c) => [c.candidate_id, c.name || c.title || c.candidate_id]))
  const verdicts = (r.attempts ?? []).map((a) => ({
    candidate_id: a.candidate_id,
    candidate_name: a.candidate_name && a.candidate_name !== a.candidate_id ? a.candidate_name : names.get(a.candidate_id) ?? a.candidate_id,
    overall_status: a.verification.overall_status,
    requirements: a.verification.requirements,
  }))
  return {
    open: true,
    statusLine: '',
    routeNote: null,
    requirements: (r.requirements ?? []).map((q) => ({ id: q.id, description: q.description ?? q.id })),
    engine: r.serpapi_meta?.engine ?? null,
    candidateCount: typeof r.candidate_count === 'number' ? r.candidate_count : (r.candidates ?? []).length,
    // keep the listed facts the UI shows (price/seller/link); unknown values stay undefined
    candidates: (r.candidates ?? []).map((c) => ({ candidate_id: c.candidate_id, name: c.name, price: c.price as string | number | null | undefined, rating: c.rating as string | number | null | undefined, seller: c.seller, source_url: c.source_url })),
    ranked: (r.ranked_candidates ?? []).map((rc) => ({ candidate_id: rc.candidate_id, rank: rc.rank, name: names.get(rc.candidate_id) })),
    verifying: null,
    verdicts,
    rejectedIds: verdicts.filter((v) => v.overall_status.toUpperCase() === 'REJECTED').map((v) => v.candidate_id),
    final: {
      status: r.status,
      selected_candidate: (r.selected_candidate ?? null) as Record<string, unknown> | null,
      verification: r.verification ?? null,
      run_id: r.run_id,
      target_type: targetTypeOf({ target_type: r.target_type, engine: r.serpapi_meta?.engine, action: r.action }),
    },
    error: null,
  }
}
