/* Agent chat engine: SSE stream (+ JSON POST fallback) -> per-message trace state.
   Extracted unchanged from App.tsx so the Assistant and the Playground drive the
   SAME real backend stream (GET /v1/agent/chat/stream, POST /v1/agent/chat). */
import { useCallback, useRef, useState } from 'react'
import { apiUrl } from './devhub'
import { traceFromRun, type StoredRun } from './replay'
import { isCandidateVerdict, normReq, rankedFromEvent, type RankedItem, type ReqItem } from './traceEvents'

export type CandItem = {
  candidate_id?: string; id?: string
  name?: string; candidate_name?: string; title?: string
  price?: string | number | null
  rating?: string | number | null
  source_url?: string; url?: string; link?: string
  [k: string]: unknown
}
export type VerdictReq = { requirement?: string; requirement_id?: string; id?: string; status: string; reason?: string }
export type VerdictBlock = { candidate_id: string; candidate_name?: string; overall_status: string; requirements: VerdictReq[] }

export type TraceState = {
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
    /** hotel | product | place | generic (from the search engine); null if unknown */
    target_type?: string | null
  } | null
  error: string | null
}

export type ChatMsg = {
  id: string
  role: 'user' | 'agent'
  text: string
  live: boolean
  trace?: TraceState
  runId?: string | null
  notice?: string | null
  replay?: boolean
}

export function emptyTrace(): TraceState {
  return {
    open: true, statusLine: 'Understanding…', routeNote: null,
    requirements: [], engine: null, candidateCount: null, candidates: [],
    ranked: [], verifying: null, verdicts: [], rejectedIds: [], final: null, error: null,
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

function loadSession(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function saveSession(key: string, id: string) {
  try { localStorage.setItem(key, id) } catch { /* ignore */ }
}

/* ---------------- SSE stream parsing ---------------- */
type StreamHandlers = { onEvent: (type: string, payload: Record<string, unknown>) => void }

async function streamAgentChat(message: string, sessionId: string | null, h: StreamHandlers, signal: AbortSignal): Promise<void> {
  const qs = new URLSearchParams({ message })
  if (sessionId) qs.set('session_id', sessionId)
  const res = await fetch(apiUrl(`/v1/agent/chat/stream?${qs.toString()}`), { headers: { Accept: 'text/event-stream' }, signal })
  if (!res.ok || !res.body) throw new Error(`stream_unavailable: HTTP ${res.status}`)
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

/** One independent chat (own messages + own server session). */
export function useAgentChat(sessionKey: string) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [sending, setSending] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const sessionRef = useRef<string | null>(loadSession(sessionKey))

  const patchTrace = useCallback((msgId: string, fn: (t: TraceState) => TraceState) => {
    setMessages((prev) => prev.map((m) => (m.id === msgId && m.trace ? { ...m, trace: fn(m.trace) } : m)))
  }, [])

  const setAgentText = useCallback((msgId: string, text: string, extra?: Partial<ChatMsg>) => {
    setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, text, ...extra } : m)))
  }, [])

  function rememberSession(id: unknown) {
    if (id) { sessionRef.current = String(id); saveSession(sessionKey, String(id)) }
  }

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
            attempt: Number(p.attempt) || t.verdicts.length + 1, of: Number(p.of) || t.ranked.length || 1,
          },
          statusLine: `Verifying ${str(p.candidate_name || p.candidate_id)}…`,
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
          const name = vb.candidate_name && vb.candidate_name !== vb.candidate_id ? vb.candidate_name
            : (t.verifying?.candidate_id === vb.candidate_id ? t.verifying.candidate_name : vb.candidate_name)
          const rejected = vb.overall_status.toUpperCase() === 'REJECTED' || vb.overall_status.toUpperCase() === 'CONTRADICTED'
            ? [...t.rejectedIds, vb.candidate_id] : t.rejectedIds
          return { ...t, verdicts: [...t.verdicts, { ...vb, candidate_name: name }], rejectedIds: rejected, verifying: null }
        })
        break
      }
      case 'final': {
        const sel = (p.selected_candidate ?? null) as CandItem | null
        const ver = (p.verification ?? null) as TraceState['final'] extends { verification: infer V } ? V : never
        patchTrace(msgId, (t) => ({
          ...t, verifying: null, statusLine: '',
          final: { status: str(p.status || 'done'), selected_candidate: sel, verification: ver, run_id: str(p.run_id) || null, target_type: str(p.target_type) || null },
        }))
        setAgentText(msgId, str(p.reply) || 'Done — see the verification trace below.', { live: false, runId: str(p.run_id) || null })
        break
      }
      case 'error':
        // backend sends {type: "error", error: "..."}
        patchTrace(msgId, (t) => ({ ...t, error: str(p.error || p.message) || 'stream error', statusLine: '' }))
        setAgentText(msgId, 'Something failed mid-verification — the trace below shows how far it got.', { live: false })
        break
      default:
        if (p.message) patchTrace(msgId, (t) => ({ ...t, statusLine: str(p.message) } as TraceState))
        break
    }
  }

  /** Fallback: full-JSON POST, then reveal the trace section by section. */
  async function runPostFallback(msgId: string, message: string) {
    const body: Record<string, string> = { message }
    if (sessionRef.current) body.session_id = sessionRef.current
    const res = await fetch(apiUrl('/v1/agent/chat'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: abortRef.current?.signal,
    })
    if (!res.ok) throw new Error(`agent_chat_unavailable: HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`)
    const j = await res.json()
    rememberSession(j.session_id)

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
      final: { status: String(j.status || 'done'), selected_candidate: sel, verification: (j.verification ?? null) as TraceState['final'] extends { verification: infer V } ? V : never, run_id: j.run_id ? String(j.run_id) : null, target_type: j.target_type ? String(j.target_type) : null },
    }))
    setAgentText(msgId, String(j.reply || 'Done — see the verification trace below.'), { live: false, runId: j.run_id ? String(j.run_id) : null })
  }

  async function send(raw: string) {
    const text = raw.trim()
    if (!text || sending) return
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    const msgId = uid()
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: 'user', text, live: false },
      { id: msgId, role: 'agent', text: '', live: true, trace: emptyTrace() },
    ])
    setSending(true)
    const signal = abortRef.current.signal

    // Prefer SSE stream for progressive trace; fall back to full-JSON POST.
    try {
      await streamAgentChat(text, sessionRef.current, {
        onEvent: (type, payload) => {
          rememberSession(payload.session_id)
          applyStreamEvent(msgId, type, payload)
        },
      }, signal)
      // If stream ended with no final + no error, fall back to POST.
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
          setAgentText(msgId, 'The ProofGate backend could not be reached. Start it with `python run.py --serve` and try again.', { live: false })
        }
      } else {
        patchTrace(msgId, (t) => ({ ...t, statusLine: '', error: msg }))
        setAgentText(msgId, 'Something failed mid-verification — the trace below shows how far it got.', { live: false })
      }
    } finally {
      setSending(false)
    }
  }

  /** Show a real stored run (GET /v1/runs/{id}) without running a new search. */
  function loadReplay(r: StoredRun) {
    const msgId = uid()
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: 'user', text: r.request, live: false },
      { id: msgId, role: 'agent', live: false, replay: true, runId: r.run_id,
        text: `Replayed from stored run ${r.run_id}. No new search was made — every status below comes from the stored record.`,
        trace: traceFromRun(r) as unknown as TraceState },
    ])
  }

  return { messages, sending, send, patchTrace, loadReplay }
}
