import { useEffect, useRef, useState, type ReactNode } from 'react'
import roboUrl from './assets/robo.png'
import { DEMO_RUN, LINKS, OUTCOMES, PICK, REQS, STEPS, mostVisible, type Verdict } from './landingContent'
import { API_BASE } from './devhub'
import { go } from './route'

/* Public homepage. Motion: CSS + SVG + IntersectionObserver only (no animation library).
   Everything still reads with prefers-reduced-motion. Illustrations are labelled as such;
   the example data is the stored Goa run c28bb2b65036 — never a live operation. */

const reduceMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function nav(to: string) {
  if (to.startsWith('scroll:')) {
    document.getElementById(to.slice(7))?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' })
    return
  }
  go(to)
}

export function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <button className="logo" onClick={onClick ?? (() => go('/'))} aria-label="ProofGate home">
      <img src={roboUrl} alt="" /><span>ProofGate</span>
    </button>
  )
}

/** Adds `.in` once to every [data-rv] element inside `root` when it scrolls into view. */
function useReveal(root: React.RefObject<HTMLElement>) {
  useEffect(() => {
    const els = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-rv]') ?? [])
    if (reduceMotion() || typeof IntersectionObserver === 'undefined') { els.forEach((e) => e.classList.add('in')); return }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target) }
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.15 })
    els.forEach((e) => io.observe(e))
    return () => io.disconnect()
  }, [root])
}

/** Exposes window scroll as --sy (px) on `root` for light parallax; off with reduced motion. */
function useScrollVar(root: React.RefObject<HTMLElement>) {
  useEffect(() => {
    if (reduceMotion()) return
    let frame = 0
    const on = () => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; root.current?.style.setProperty('--sy', String(Math.min(window.scrollY, 1600))) })
    }
    window.addEventListener('scroll', on, { passive: true })
    on()
    return () => { window.removeEventListener('scroll', on); cancelAnimationFrame(frame) }
  }, [root])
}

const MARK: Record<Verdict, { sym: string; cls: string; text: string }> = {
  S: { sym: '✓', cls: 'ok', text: 'satisfied' },
  U: { sym: '?', cls: 'warn', text: 'unknown' },
  C: { sym: '✕', cls: 'bad', text: 'contradicted' },
}
function Mark({ v, i = 0 }: { v: Verdict; i?: number }) {
  return <span className={`cell ${MARK[v].cls}`} style={{ '--i': i } as React.CSSProperties}><span aria-hidden>{MARK[v].sym}</span><span className="sr">{MARK[v].text}</span></span>
}

/* ---------------------------------------------------------------- hero illustration (kept, enhanced) */
function PipelineArt() {
  return (
    <div className="art art2" role="img" aria-label="Illustration: an agent action flows through requirements, evidence and Jev verification to one of three outcomes">
      <span className="art-glow g1" aria-hidden /><span className="art-glow g2" aria-hidden />
      <div className="art-card art-action hl hl-1">
        <small>Agent action</small>
        <b>Book a hotel in Goa</b>
        <span>≤ Rs 10,000 · 2 guests · beachfront · breakfast · free cancellation</span>
      </div>
      <div className="art-wire w1"><i /></div>
      <div className="art-row art-reqs hl hl-2">
        {['budget', 'guests', 'beachfront', 'breakfast', 'cancellation'].map((r, i) => <span key={r} style={{ animationDelay: `${0.5 + i * 0.12}s` }}>{r}</span>)}
      </div>
      <div className="art-wire w2"><i /></div>
      <div className="art-row art-evidence">
        <div className="art-node hl hl-3"><small>Evidence</small><b>SerpApi</b><span>live candidates</span></div>
        <div className="art-node jev hl hl-4"><small>Verifier</small><b>TypeSafe Jev</b><span>rules on each requirement</span></div>
      </div>
      <div className="art-wire w3"><i /></div>
      <div className="art-row art-out hl hl-5">
        <span className="vpill ok">VERIFIED → may proceed</span>
        <span className="vpill warn">UNVERIFIED → human review</span>
        <span className="vpill bad">REJECTED → blocked</span>
      </div>
      <p className="art-caption">Illustration of the real pipeline</p>
    </div>
  )
}

/* ---------------------------------------------------------------- how it works: per-stage visuals */
function StageVisual({ id }: { id: (typeof STEPS)[number]['id'] }) {
  switch (id) {
    case 'action':
      return <div className="sv sv-action"><small>Proposed by your agent</small><b>Book a hotel in Goa</b><p>under Rs 10,000 · 2 people · beachfront · breakfast included · free cancellation</p></div>
    case 'reqs':
      return <div className="sv sv-reqs">{REQS.map((r, i) => <span key={r} className="sv-chip" style={{ '--i': i } as React.CSSProperties}>{r}<em>required</em></span>)}</div>
    case 'evidence':
      return (
        <div className="sv sv-ev">
          {[[PICK.name, PICK.price], ['Sibaya Beach Resort', 'listed price'], ['BEACHOUSE beachfront cottages', 'listed price']].map(([n, p], i) => (
            <div key={n} className="sv-row" style={{ '--i': i } as React.CSSProperties}><span className="sv-dot" /><b>{n}</b><small>{p}</small></div>
          ))}
          <small className="sv-foot">15 candidates from SerpApi in run {DEMO_RUN}</small>
        </div>
      )
    case 'jev':
      return (
        <div className="sv sv-jev">
          <b>{PICK.name}</b>
          {REQS.map((r, i) => <div key={r} className="sv-verdict" style={{ '--i': i } as React.CSSProperties}><span>{r}</span><span className={`vpill ${MARK[PICK.verdicts[i]].cls}`}>{({ S: 'SATISFIED', U: 'UNKNOWN', C: 'CONTRADICTED' })[PICK.verdicts[i]]}</span></div>)}
        </div>
      )
    case 'decision':
      return (
        <div className="sv sv-rules">
          <div className="rule"><span className="vpill bad">any CONTRADICTED</span><span>→ REJECTED</span></div>
          <div className="rule hit"><span className="vpill warn">any UNKNOWN</span><span>→ NEEDS REVIEW</span><em>matches {PICK.name}</em></div>
          <div className="rule"><span className="vpill ok">all SATISFIED</span><span>→ VERIFIED</span></div>
        </div>
      )
    case 'review':
      return (
        <div className="sv sv-review">
          <span className="final-badge warn">◷ NEEDS HUMAN REVIEW</span>
          <p>Not confirmed: sleeps 2 guests, beachfront, free cancellation.</p>
          <label className="sv-ack"><span className="box" aria-hidden>✓</span> I reviewed these points and want to proceed</label>
          <small>Then a simulated booking — nothing real is reserved.</small>
        </div>
      )
  }
}

function HowItWorks() {
  const [active, setActive] = useState(0)
  const refs = useRef<(HTMLElement | null)[]>([])
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const ratios = STEPS.map(() => 0)
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) ratios[refs.current.indexOf(en.target as HTMLElement)] = en.isIntersecting ? en.intersectionRatio : 0
      setActive((cur) => mostVisible(ratios, cur))
    }, { rootMargin: '-35% 0px -35% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] })
    refs.current.forEach((el) => el && io.observe(el))
    return () => io.disconnect()
  }, [])

  return (
    <section className="lp-sec hiw" id="how" aria-labelledby="how-title">
      <div className="lp-head" data-rv>
        <span className="eyebrow">How it works</span>
        <h2 id="how-title">From a proposed action to an accountable decision.</h2>
      </div>
      <div className="hiw-grid">
        <div className="hiw-stage" aria-hidden>
          <div className="hiw-panel">
            <ol className="hiw-rail" style={{ '--p': active / (STEPS.length - 1) } as React.CSSProperties}>
              {STEPS.map((s, i) => <li key={s.id} className={i < active ? 'done' : i === active ? 'on' : ''}><span>{s.n}</span></li>)}
            </ol>
            <div className="hiw-screen">
              {STEPS.map((s, i) => <div key={s.id} className={'hiw-view' + (i === active ? ' on' : '')}><StageVisual id={s.id} /></div>)}
            </div>
            <p className="hiw-cap">Example: stored run {DEMO_RUN}</p>
          </div>
        </div>
        <ol className="hiw-steps">
          {STEPS.map((s, i) => (
            <li key={s.id} ref={(el) => { refs.current[i] = el }} className={'hiw-step' + (i === active ? ' on' : '')}>
              <span className="hiw-n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <div className="hiw-inline"><StageVisual id={s.id} /></div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}

/* ---------------------------------------------------------------- why it matters: branching outcomes */
function Outcomes() {
  return (
    <section className="lp-sec why2" aria-labelledby="why-title">
      <div className="lp-head center" data-rv>
        <span className="eyebrow">Why it matters</span>
        <h2 id="why-title">Relevant isn’t the same as right.</h2>
        <p className="lede">The same request, three different candidates. Evidence — not ranking — decides what happens next.</p>
      </div>
      <div className="branch" data-rv>
        <div className="branch-src">
          <small>Agent action</small>
          <b>Book this hotel</b>
          <span className="branch-reqs">{['Budget', 'Beachfront', 'Free cancellation'].map((r) => <em key={r}>{r}</em>)}</span>
        </div>
        <svg className="branch-svg" viewBox="0 0 200 300" preserveAspectRatio="none" aria-hidden>
          <path pathLength={1} className="bp ok" d="M0 150 C 90 150, 110 50, 200 50" />
          <path pathLength={1} className="bp warn" d="M0 150 C 90 150, 110 150, 200 150" />
          <path pathLength={1} className="bp bad" d="M0 150 C 90 150, 110 250, 200 250" />
        </svg>
        <ul className="branch-out">
          {OUTCOMES.map((o, k) => (
            <li key={o.id} className={`oc ${o.id}`} style={{ '--k': k } as React.CSSProperties}>
              <span className="oc-marks">{o.marks.map((m, i) => <Mark key={i} v={m} i={i} />)}</span>
              <span className="oc-text"><b className={`vpill ${o.id}`}>{o.status}</b><span>{o.line}</span></span>
              <span className="oc-then">{o.then}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="lp-note" data-rv>Illustration of the rules ProofGate applies to every candidate. ✓ satisfied · ? unknown · ✕ contradicted.</p>
    </section>
  )
}

/* ---------------------------------------------------------------- product preview (real run) */
const PREVIEW_ROWS: [string, 'UNVERIFIED' | 'REJECTED', Verdict[]][] = [
  ['Silver Sands Holiday Village', 'UNVERIFIED', ['S', 'U', 'U', 'S', 'U']],
  ['BEACHOUSE beachfront cottages', 'UNVERIFIED', ['S', 'U', 'S', 'S', 'U']],
  ['Sibaya Beach Resort', 'REJECTED', ['C', 'U', 'U', 'S', 'U']],
]

function Preview() {
  return (
    <section className="lp-sec prev2" aria-labelledby="prev-title">
      <div className="prev-copy" data-rv>
        <span className="eyebrow">Product preview</span>
        <h2 id="prev-title">See exactly why an option passed or failed.</h2>
        <p className="lede">In this real Goa search no hotel could be fully verified. ProofGate said so — it flagged the best match for review and rejected the hotels whose evidence contradicted a requirement.</p>
        <button className="btn secondary" onClick={() => nav(LINKS.previewRun)}>Inspect this run →</button>
      </div>
      <div className="preview2 card" data-rv>
        <div className="pv-head"><b>How I verified this</b><small>stored run {DEMO_RUN}</small></div>
        <div className="req-chips">{REQS.map((r, i) => <span className="req-chip" key={r} style={{ '--i': i } as React.CSSProperties}>{r}</span>)}</div>
        <div className="pv-rows">
          {PREVIEW_ROWS.map(([n, s, cells], r) => (
            <div className={'pv-row' + (r === 0 ? ' pick' : '') + (s === 'REJECTED' ? ' rej' : '')} key={n} style={{ '--r': r } as React.CSSProperties}>
              <span className="pv-name">{n}</span>
              <span className="pv-cells">{cells.map((c, i) => <Mark key={i} v={c} i={i} />)}</span>
              <span className={`vpill ${s === 'REJECTED' ? 'bad' : 'warn'}`}>{s}</span>
            </div>
          ))}
        </div>
        <div className="pv-link" aria-hidden />
        <div className="final warn pv-final">
          <span className="final-badge warn">◷ NEEDS REVIEW</span>
          <div className="final-name">{PICK.name}</div>
          <p className="flag-intro">Guests, beachfront and cancellation remain unverified — a person decides.</p>
        </div>
      </div>
    </section>
  )
}

/* ---------------------------------------------------------------- developers */
const CODE: { t: string; hl?: boolean; c?: boolean }[] = [
  { t: 'curl -s localhost:8000/v1/find-and-verify \\' },
  { t: '  -H "Content-Type: application/json" \\' },
  { t: `  -d '{"request": "Hotel in Goa under Rs 10,000,` },
  { t: `       2 people, beachfront", "action": "book_hotel"}'` },
  { t: '' },
  { t: '{', c: true },
  { t: '  "status": "needs_human_review",', c: true, hl: true },
  { t: '  "attempts": [{ "candidate_id": "c3",', c: true },
  { t: '    "verification": { "overall_status": "UNVERIFIED" … } }]', c: true },
  { t: '}', c: true },
]

function Interface({ title, status, tone, children, to }: { title: string; status: string; tone: 'ok' | 'local' | 'soon'; children: ReactNode; to: string }) {
  return (
    <li>
      <button className="if-row" onClick={() => nav(to)}>
        <span className="if-top"><b>{title}</b><span className={`if-status ${tone}`}>{status}</span></span>
        <span className="if-body">{children}</span>
        <span className="if-arrow" aria-hidden>→</span>
      </button>
    </li>
  )
}

function Developers() {
  return (
    <section className="lp-sec dev2l" aria-labelledby="dev-title">
      <div className="dev-copy" data-rv>
        <span className="eyebrow">For developers</span>
        <h2 id="dev-title">One verification layer, several ways in.</h2>
        <ul className="if-list">
          <Interface title="REST API" status="Available" tone="ok" to={LINKS.devRest}>Verify a request, read runs and evidence over HTTP.</Interface>
          <Interface title="Live trace (SSE)" status="Available" tone="ok" to={LINKS.devStream}>Stream every pipeline step as it happens.</Interface>
          <Interface title="MCP server" status="Available · stdio" tone="ok" to={LINKS.devMcp}>Implemented and tested — you connect your AI app.</Interface>
          <Interface title="Python client & SDKs" status="Local only · TS coming soon" tone="local" to={LINKS.devSdks}>Python client works from the repo; nothing is published yet.</Interface>
        </ul>
      </div>
      <figure className="code-win" data-rv>
        <figcaption><span className="dots" aria-hidden><i /><i /><i /></span>POST /v1/find-and-verify<small>uses API credits</small></figcaption>
        <pre><code>{CODE.map((l, i) => <span key={i} className={'ln' + (l.hl ? ' hl' : '') + (l.c ? ' res' : '')} style={{ '--i': i } as React.CSSProperties}>{l.t || ' '}{'\n'}</span>)}</code></pre>
      </figure>
    </section>
  )
}

/* ---------------------------------------------------------------- page */
export default function Landing() {
  const root = useRef<HTMLDivElement>(null)
  useReveal(root)
  useScrollVar(root)

  return (
    <div className="landing lp" ref={root}>
      <span className="lp-bg b1" aria-hidden /><span className="lp-bg b2" aria-hidden />
      <header className="site-nav">
        <Logo />
        <nav className="site-links" aria-label="Site">
          <button onClick={() => nav(LINKS.navProduct)}>Product</button>
          <button onClick={() => nav(LINKS.navPlayground)}>Playground</button>
          <button onClick={() => nav(LINKS.navDevelopers)}>Developers</button>
        </nav>
        <div className="site-cta">
          <button className="btn ghost sm" onClick={() => nav(LINKS.navSignIn)}>Sign in</button>
          <button className="btn primary sm" onClick={() => nav(LINKS.navGetStarted)}>Get started</button>
        </div>
      </header>

      <section className="l-hero lp-hero">
        <div className="l-hero-copy">
          <span className="eyebrow rise r1">Action verification for AI agents</span>
          <h1 className="rise r2">Agents act fast.<br /><em>ProofGate checks the proof first.</em></h1>
          <p className="lede rise r3">Before an agent books, buys or commits, ProofGate turns the request into explicit requirements, gathers live evidence, and has TypeSafe Jev rule on every one. Contradicted options are rejected. Uncertain ones go to a human. Only fully supported actions proceed.</p>
          <div className="l-ctas rise r4">
            <button className="btn primary" onClick={() => nav(LINKS.heroPrimary)}>Open the Playground</button>
            <button className="btn secondary" onClick={() => nav(LINKS.heroSecondary)}>See how it works ↓</button>
          </div>
          <p className="fine rise r5">Live use case in this build: hotel and product search with a simulated booking or order — no real reservations or payments.</p>
        </div>
        <div className="art-wrap"><PipelineArt /></div>
      </section>

      <HowItWorks />
      <Outcomes />
      <Preview />
      <Developers />

      <section className="lp-final" data-rv aria-labelledby="final-title">
        <h2 id="final-title">Give your agent a reason to be trusted.</h2>
        <p>Try the full flow in the demo workspace, or wire ProofGate into your own agent.</p>
        <div className="l-ctas center">
          <button className="btn primary" onClick={() => nav(LINKS.finalPrimary)}>Enter the demo workspace</button>
          <button className="btn secondary" onClick={() => nav(LINKS.finalSecondary)}>Explore the Developer Hub</button>
        </div>
      </section>

      <footer className="site-foot lp-foot">
        <Logo />
        <span>Search finds candidates. ProofGate finds the one that actually fits.</span>
        <nav aria-label="Footer">
          <button onClick={() => nav(LINKS.footPlayground)}>Playground</button>
          <button onClick={() => nav(LINKS.footDevelopers)}>Developer Hub</button>
          <button onClick={() => nav(LINKS.footSignIn)}>Sign in</button>
          <a href={`${API_BASE}/docs`} target="_blank" rel="noreferrer" title="FastAPI docs served by the ProofGate backend">API docs ↗</a>
        </nav>
      </footer>
    </div>
  )
}
