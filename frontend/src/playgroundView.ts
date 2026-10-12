/* Playground presentation model (no React) — unit-tested with `node --test`.
   Everything is derived from the trace the backend actually sent; candidates are
   joined to their Jev verdicts by candidate_id, never by list position. */
import type { TraceState } from './chat'
import { pipelineStages, verdictForCandidate, type StageState } from './traceEvents.ts'

type Trace = Pick<TraceState, 'requirements' | 'candidateCount' | 'candidates' | 'ranked' | 'verifying' | 'verdicts' | 'final' | 'error' | 'engine'>
export type CardStatus = 'VERIFIED' | 'UNVERIFIED' | 'REJECTED' | 'CHECKING' | 'NOT_CHECKED' | 'PENDING'
export type Cond = { id: string; label: string; status: 'SATISFIED' | 'UNKNOWN' | 'CONTRADICTED' | 'NO_VERDICT'; reason: string | null }

export type CandidateCard = {
  candidate_id: string
  rank: number | null
  name: string
  price: string | null
  seller: string | null
  url: string | null
  status: CardStatus
  conditions: Cond[]          // one per requirement, in requirement order
  explanation: string
}

const SHORT = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

export function explain(status: CardStatus, conds: Cond[], hasFinal: boolean): string {
  const of = (st: Cond['status']) => conds.filter((c) => c.status === st).map((c) => c.label)
  const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`)
  switch (status) {
    case 'VERIFIED': return 'Jev confirmed every required condition from the evidence.'
    case 'REJECTED': {
      const c = of('CONTRADICTED')
      return c.length ? `Evidence contradicts: ${list(c)}.` : 'Jev found a required condition contradicted.'
    }
    case 'UNVERIFIED': {
      const u = of('UNKNOWN')
      return u.length ? `Not confirmed by the evidence: ${list(u)}.` : 'Some required conditions could not be confirmed.'
    }
    case 'CHECKING': return 'Jev is checking this option now…'
    case 'NOT_CHECKED': return hasFinal ? 'Not checked — Jev stops once an earlier option is fully verified.' : 'Waiting for Jev…'
    default: return 'Waiting for Jev…'
  }
}

export function buildCards(t: Trace): CandidateCard[] {
  const info = new Map(t.candidates.map((c) => [String(c.candidate_id ?? c.id ?? ''), c]))
  const order: { id: string; rank: number | null }[] = t.ranked.length
    ? t.ranked.map((r, i) => ({ id: String(r.candidate_id ?? r.id ?? i), rank: r.rank ?? i + 1 }))
    : t.verdicts.map((v) => ({ id: v.candidate_id, rank: null }))
  // Verdicts for candidates the ranking never listed are still shown, never dropped.
  for (const v of t.verdicts) if (!order.some((o) => o.id === v.candidate_id)) order.push({ id: v.candidate_id, rank: null })

  return order.map(({ id, rank }) => {
    const c = info.get(id)
    const v = verdictForCandidate(t.verdicts, id)
    const conditions: Cond[] = t.requirements.map((req) => {
      const r = v?.requirements.find((x) => (x.requirement_id ?? x.id) === req.id)
      const st = (r?.status ?? '').toUpperCase()
      return {
        id: req.id, label: SHORT(req.description),
        status: st === 'SATISFIED' || st === 'UNKNOWN' || st === 'CONTRADICTED' ? st : 'NO_VERDICT',
        reason: r?.reason ?? null,
      }
    })
    const overall = v?.overall_status.toUpperCase()
    const status: CardStatus = overall === 'VERIFIED' || overall === 'UNVERIFIED' || overall === 'REJECTED' ? overall
      : t.verifying?.candidate_id === id ? 'CHECKING' : t.final ? 'NOT_CHECKED' : 'PENDING'
    const price = c?.price === null || c?.price === undefined || c?.price === '' ? null : String(c.price)
    const name = String(c?.name ?? c?.candidate_name ?? v?.candidate_name ?? t.ranked.find((r) => String(r.candidate_id) === id)?.name ?? id)
    const url = typeof c?.source_url === 'string' && c.source_url ? c.source_url : null
    return {
      candidate_id: id, rank, name, price, url,
      seller: typeof c?.seller === 'string' && c.seller ? c.seller : null,
      status, conditions, explanation: explain(status, conditions, !!t.final),
    }
  })
}

/* ---------- the single decision summary ---------- */
export type Summary = {
  tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'live'
  title: string
  body: string
  next: string
  counts: { VERIFIED: number; UNVERIFIED: number; REJECTED: number } | null
  focus: string | null      // candidate_id the summary points at (the backend's selection)
}

export function summarize(t: Trace | null, cards: CandidateCard[], live: boolean): Summary | null {
  if (!t) return null
  const counts = { VERIFIED: 0, UNVERIFIED: 0, REJECTED: 0 }
  for (const v of t.verdicts) {
    const k = v.overall_status.toUpperCase() as keyof typeof counts
    if (k in counts) counts[k]++
  }
  const sel = t.final?.selected_candidate
  const focusId = sel ? String(sel.candidate_id ?? sel.id ?? '') || null : null
  const focus = focusId ? cards.find((c) => c.candidate_id === focusId) ?? null : null
  const rejectedNote = counts.REJECTED ? ` ${counts.REJECTED} ${counts.REJECTED === 1 ? 'option was' : 'options were'} rejected — each card shows which condition was contradicted.` : ''

  if (t.error) return { tone: 'bad', title: 'The run failed', body: t.error, next: 'Check that the backend is running, then try again.', counts: t.verdicts.length ? counts : null, focus: null }
  if (!t.final) {
    return live
      ? { tone: 'live', title: 'Verifying…', body: t.verdicts.length ? `Jev has checked ${t.verdicts.length} option${t.verdicts.length === 1 ? '' : 's'} so far.` : 'Searching and checking requirements.', next: 'Results appear below as each option is checked.', counts: t.verdicts.length ? counts : null, focus: null }
      : { tone: 'neutral', title: 'No decision was produced', body: 'The run ended without a final decision.', next: 'Try the request again.', counts: t.verdicts.length ? counts : null, focus: null }
  }
  const st = t.final.status.toLowerCase()
  if (st === 'direct') return { tone: 'neutral', title: 'Answered directly', body: 'No search was needed for this request, so nothing was verified.', next: 'Ask for something to find or buy to run verification.', counts: null, focus: null }
  if (st === 'verified' && focus) {
    return { tone: 'ok', title: 'Verified match found', body: `${focus.name} met every required condition.${rejectedNote}`, next: 'Review it and run the simulated action if it suits you.', counts, focus: focus.candidate_id }
  }
  if (st === 'needs_human_review' && focus) {
    const isRejected = focus.status === 'REJECTED'
    return {
      tone: 'warn',
      title: 'No fully verified match — needs your review',
      body: isRejected
        ? `Every checked option had a contradicted condition. The top-ranked one, ${focus.name}, is shown for reference only.${rejectedNote}`
        : `Best available: ${focus.name}. ${focus.explanation}${rejectedNote}`,
      next: isRejected ? 'Refine the request — rejected options cannot proceed.' : 'Open it, check the unconfirmed conditions yourself, then decide whether to simulate.',
      counts, focus: focus.candidate_id,
    }
  }
  return {
    tone: 'bad', title: 'No eligible match',
    body: cards.length ? `Nothing could be selected.${rejectedNote}` : 'The search returned no candidates.',
    next: 'Try a broader or differently worded request.', counts: t.verdicts.length ? counts : null, focus: null,
  }
}

/* ---------- slim journey: Request → Requirements → Search → Evidence & Jev → Decision ---------- */
export type Journey = { id: string; label: string; state: StageState; detail: string }[]

export function journey(t: Trace | null, live: boolean): Journey {
  const s = pipelineStages(t, live)
  const evidence: StageState = s.verify === 'done' ? 'done'
    : s.rank === 'error' || s.verify === 'error' ? 'error'
    : s.rank === 'active' || s.verify === 'active' ? 'active'
    : s.rank === 'skipped' && s.verify === 'skipped' ? 'skipped'
    : s.rank === 'done' ? s.verify : 'idle'
  return [
    { id: 'request', label: 'Request', state: t ? 'done' : 'idle', detail: t ? 'received' : '' },
    { id: 'requirements', label: 'Requirements', state: s.understand, detail: t?.requirements.length ? `${t.requirements.length} found` : '' },
    { id: 'search', label: 'Search', state: s.search, detail: t && t.candidateCount !== null ? `${t.candidateCount} results` : '' },
    { id: 'evidence', label: 'Evidence & Jev', state: evidence, detail: t?.verdicts.length ? `${t.verdicts.length} checked` : '' },
    { id: 'decision', label: 'Decision', state: s.decide, detail: t?.final ? t.final.status.replace(/_/g, ' ') : '' },
  ]
}

/** Price label honest to the action type: hotels list a nightly rate, products a listed price. */
export function priceLabel(targetType: string | null | undefined): string {
  return targetType === 'hotel' ? 'per night, as listed' : 'as listed'
}

/** The one-line decision a person reads first. Never says "Verified" unless the backend verified
    the pick; a needs-review run whose only option was rejected reads as "No verified match". */
export function decisionHeading(s: Summary, cards: CandidateCard[]): string {
  if (s.tone === 'ok') return 'Verified'
  if (s.tone === 'warn') {
    const focus = cards.find((c) => c.candidate_id === s.focus)
    return focus?.status === 'REJECTED' ? 'No verified match' : 'Needs human review'
  }
  if (s.tone === 'bad' && !/failed/i.test(s.title)) return 'No verified match'
  return s.title
}

/** Short plain-language tally of a candidate's conditions, e.g. "2 of 3 confirmed · 1 didn't match". */
export function condTally(c: CandidateCard): string {
  const n = { SATISFIED: 0, UNKNOWN: 0, CONTRADICTED: 0 }
  for (const x of c.conditions) if (x.status !== 'NO_VERDICT') n[x.status]++
  const checked = n.SATISFIED + n.UNKNOWN + n.CONTRADICTED
  if (!checked) return ''
  return [`${n.SATISFIED} of ${checked} confirmed`, n.UNKNOWN ? `${n.UNKNOWN} unconfirmed` : '', n.CONTRADICTED ? `${n.CONTRADICTED} didn't match` : '']
    .filter(Boolean).join(' · ')
}
