import { useEffect, useState } from 'react'
import Composer from './Composer'
import { EXAMPLES } from './Assistant'
import { BookButton, FinalCard, VerdictPill, verdictClass } from './Trace'
import type { ChatMsg, useAgentChat } from './chat'
import { pipelineStages, rankReasonFor, STAGES, verdictForCandidate, type StageState } from './traceEvents'

/* Playground: the same live pipeline as the Assistant, laid out as an inspectable
   run. Every stage/state below is derived from events the backend actually sent. */

const STATE_LABEL: Record<StageState, string> = { idle: 'Waiting', active: 'Running', done: 'Done', skipped: 'Not reached', error: 'Failed' }

export default function Playground({ chat }: { chat: ReturnType<typeof useAgentChat> }) {
  const { messages, sending, send, loadReplay } = chat
  const [stored, setStored] = useState<{ run_id: string; request: string }[]>([])
  const [replayId, setReplayId] = useState('')
  const [replayErr, setReplayErr] = useState<string | null>(null)
  const [replaying, setReplaying] = useState(false)

  useEffect(() => {
    fetch('/v1/runs?limit=10').then((r) => (r.ok ? r.json() : [])).then((rows) => {
      if (Array.isArray(rows)) { setStored(rows); if (rows[0]) setReplayId(rows[0].run_id) }
    }).catch(() => setStored([]))
  }, [])

  function replay() {
    if (!replayId || replaying) return
    setReplaying(true); setReplayErr(null)
    fetch(`/v1/runs/${encodeURIComponent(replayId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((doc) => { setPick(null); loadReplay(doc) })
      .catch((e: Error) => setReplayErr(`Could not load run (${e.message}).`))
      .finally(() => setReplaying(false))
  }
  const [input, setInput] = useState(EXAMPLES[0])
  const runs = messages.filter((m): m is ChatMsg & { trace: NonNullable<ChatMsg['trace']> } => m.role === 'agent' && !!m.trace)
  const [pick, setPick] = useState<number | null>(null)
  const idx = pick ?? runs.length - 1
  const run = runs[idx] ?? null
  const request = run ? messages[messages.indexOf(run) - 1]?.text : null
  const t = run?.trace ?? null
  const stages = pipelineStages(t, !!run?.live)

  function submit() {
    if (!input.trim() || sending) return
    setPick(null)
    void send(input)
  }

  const counts = { VERIFIED: 0, UNVERIFIED: 0, REJECTED: 0 }
  for (const v of t?.verdicts ?? []) {
    const k = v.overall_status.toUpperCase() as keyof typeof counts
    if (k in counts) counts[k]++
  }
  const metric: Record<string, string> = {
    understand: t?.requirements.length ? `${t.requirements.length} requirements` : '',
    search: t && t.candidateCount !== null ? `${t.candidateCount} candidates${t.engine ? ` · ${t.engine}` : ''}` : '',
    rank: t?.ranked.length ? `${t.ranked.length} ranked` : '',
    verify: t?.verdicts.length ? `${t.verdicts.length} checked${t.verifying ? ' · checking…' : ''}` : t?.verifying ? 'checking…' : '',
    decide: t?.final ? t.final.status.replace(/_/g, ' ') : '',
  }

  return (
    <div className="page-scroll">
      <div className="pg-page playground enter">
        <header className="page-head">
          <div>
            <span className="eyebrow">Playground</span>
            <h1>Watch an action get verified.</h1>
            <p className="lede">Type an action request. ProofGate parses its requirements, searches live with SerpApi, ranks candidates, and asks TypeSafe Jev to rule on every requirement — then decides what may proceed.</p>
          </div>
          <div className="live-note"><span className="dot" />Live pipeline · each run makes real SerpApi, LLM and Jev calls</div>
        </header>

        <section className="card pad">
          <Composer size="lg" value={input} onChange={setInput} onSubmit={submit} disabled={sending}
            placeholder="Describe an action to verify, e.g. a hotel with hard requirements…" />
          <div className="chips left">
            {EXAMPLES.slice(0, 2).map((ex) => <button key={ex} className="chip sm" onClick={() => setInput(ex)}>{ex.length > 60 ? ex.slice(0, 58) + '…' : ex}</button>)}
            {stored.length > 0 && (
              <span className="replay">
                <label>Replay stored run
                  <select value={replayId} onChange={(e) => setReplayId(e.target.value)}>
                    {stored.map((r) => <option key={r.run_id} value={r.run_id}>{r.run_id} · {r.request.slice(0, 38)}{r.request.length > 38 ? '…' : ''}</option>)}
                  </select>
                </label>
                <button className="btn secondary sm" onClick={replay} disabled={replaying || sending}>{replaying ? 'Loading…' : 'Replay · no credits'}</button>
              </span>
            )}
            {runs.length > 1 && (
              <label className="run-pick">Run
                <select value={idx} onChange={(e) => setPick(Number(e.target.value))}>
                  {runs.map((r, i) => <option key={r.id} value={i}>#{i + 1} {r.replay ? 'replay ' : ''}{r.runId ?? (r.live ? 'running' : 'no run id')}</option>)}
                </select>
              </label>
            )}
          </div>
          {replayErr && <p className="err-text sm">{replayErr}</p>}
        </section>

        <section className="pipeline" aria-label="Verification pipeline">
          {STAGES.map((s, i) => (
            <div key={s.id} className={`stage ${stages[s.id]}`}>
              <div className="stage-node">
                <span className="stage-n">{i + 1}</span>
                {stages[s.id] === 'active' && <span className="stage-pulse" aria-hidden />}
              </div>
              <div className="stage-body">
                <b>{s.label}</b>
                <small>{metric[s.id] || s.detail}</small>
                <em>{STATE_LABEL[stages[s.id]]}</em>
              </div>
              {i < STAGES.length - 1 && <span className="stage-link" aria-hidden />}
            </div>
          ))}
        </section>

        {!t && (
          <section className="card pad empty-state">
            <div className="empty-ico" aria-hidden>◎</div>
            <h3>No run yet</h3>
            <p>Run the example above (or dictate your own). Nothing is shown here until the backend sends real events — no sample results are faked.</p>
          </section>
        )}

        {t && (
          <div className="pg-grid">
            <div className="col">
              <section className="card pad enter">
                <div className="card-head"><h3>Request</h3><span className="tally">{run?.replay && <span className="status-tag">replayed · stored run</span>}{run?.runId && <code className="tag">run {run.runId}</code>}</span></div>
                <p className="quote">{request}</p>
                {t.statusLine && run?.live && <div className="stage-line"><span className="spinner" />{t.statusLine}</div>}
                {t.error && <p className="err-text">Failed: {t.error}</p>}
              </section>

              <section className="card pad enter">
                <div className="card-head"><h3>Requirements</h3><span className="muted sm">{t.requirements.length || '—'}</span></div>
                {t.requirements.length ? (
                  <div className="req-chips">{t.requirements.map((r) => <span key={r.id} className="req-chip" title={r.id}>{r.description}</span>)}</div>
                ) : <p className="muted sm">Waiting for the parser…</p>}
              </section>

              <section className="card pad enter">
                <div className="card-head"><h3>Candidate ranking</h3><span className="muted sm">{t.ranked.length ? `${t.ranked.length} of ${t.candidateCount ?? '?'}` : ''}</span></div>
                {t.ranked.length === 0 ? <p className="muted sm">{t.candidateCount === 0 ? 'No candidates returned.' : 'Waiting for ranking…'}</p> : (
                  <ol className="rank-table">
                    {t.ranked.map((r, i) => {
                      const id = String(r.candidate_id ?? r.id ?? i)
                      const v = verdictForCandidate(t.verdicts, id)
                      const checking = t.verifying?.candidate_id === id
                      return (
                        <li key={id} className={v ? verdictClass(v.overall_status) : ''}>
                          <span className="rank-n">#{r.rank ?? i + 1}</span>
                          <span className="rt-main">
                            <span className="rank-name">{String(r.name ?? id)}</span>
                            <small>{rankReasonFor(v?.overall_status)}</small>
                          </span>
                          <span className="rt-side">
                            {v ? <VerdictPill status={v.overall_status} /> : checking ? <span className="vpill pending"><span className="spinner xs" />checking</span> : <span className="vpill idle">not checked</span>}
                            {v && <BookButton runId={t.final?.run_id} candidateId={id} status={v.overall_status} />}
                          </span>
                        </li>
                      )
                    })}
                  </ol>
                )}
              </section>
            </div>

            <div className="col">
              <section className="card pad enter">
                <div className="card-head">
                  <h3>Jev verdicts</h3>
                  {t.verdicts.length > 0 && (
                    <span className="tally">
                      <span className="vpill ok">{counts.VERIFIED} verified</span>
                      <span className="vpill warn">{counts.UNVERIFIED} unverified</span>
                      <span className="vpill bad">{counts.REJECTED} rejected</span>
                    </span>
                  )}
                </div>
                {t.verdicts.length === 0 ? <p className="muted sm">{t.verifying ? `Jev is checking ${t.verifying.candidate_name}…` : 'Verdicts appear here as Jev rules on each candidate.'}</p> : (
                  <div className="matrix-wrap">
                    <table className="matrix">
                      <thead><tr><th>Candidate</th>{t.requirements.map((r) => <th key={r.id} title={r.description}>{r.id.replace(/_included$/, '').replace(/_/g, ' ')}</th>)}<th>Overall</th></tr></thead>
                      <tbody>
                        {t.verdicts.map((v) => (
                          <tr key={v.candidate_id} className="enter">
                            <td className="m-name">{v.candidate_name || v.candidate_id}</td>
                            {t.requirements.map((req) => {
                              const r = v.requirements.find((x) => (x.requirement_id ?? x.id) === req.id)
                              const s = r?.status ?? '—'
                              return <td key={req.id}><span className={`cell ${r ? verdictClass(s) : ''}`} title={`${req.description}: ${s}${r?.reason ? ' — ' + r.reason : ''}`}>{s === 'SATISFIED' ? '✓' : s === 'CONTRADICTED' ? '✕' : s === 'UNKNOWN' ? '?' : '—'}</span></td>
                            })}
                            <td><VerdictPill status={v.overall_status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="legend"><span className="cell ok">✓</span> satisfied <span className="cell warn">?</span> unknown <span className="cell bad">✕</span> contradicted</p>
                  </div>
                )}
              </section>

              <section className="card pad enter">
                <div className="card-head"><h3>Policy decision</h3></div>
                {t.final ? <FinalCard fin={t.final} /> : <p className="muted sm">{run?.live ? 'Decided after Jev finishes…' : 'No decision was produced.'}</p>}
                {t.final && (
                  <p className="policy-note">Rules: any required point <b>contradicted</b> → rejected, never bookable. Any required point <b>unknown</b> → human review before an action can be simulated. Only all-satisfied → verified.</p>
                )}
              </section>

              {run && !run.live && run.text && (
                <section className="card pad enter">
                  <div className="card-head"><h3>Agent summary</h3></div>
                  <p className="reply">{run.text}</p>
                </section>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
