import roboUrl from './assets/robo.png'
import { go } from './route'

/* Public homepage. Copy describes only what this build does; anything not built is
   labelled. The product preview is modelled on a real stored run (c28bb2b65036). */

export function Logo({ onClick }: { onClick?: () => void }) {
  return (
    <button className="logo" onClick={onClick ?? (() => go('/'))} aria-label="ProofGate home">
      <img src={roboUrl} alt="" /><span>ProofGate</span>
    </button>
  )
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function PipelineArt() {
  return (
    <div className="art" role="img" aria-label="Illustration: an agent action flows through requirements, evidence and Jev verification to a decision">
      <div className="art-card art-action">
        <small>Agent action</small>
        <b>Book a hotel in Goa</b>
        <span>≤ Rs 10,000 · 2 guests · beachfront · breakfast · free cancellation</span>
      </div>
      <div className="art-wire w1"><i /></div>
      <div className="art-row art-reqs">
        {['budget', 'guests', 'beachfront', 'breakfast', 'cancellation'].map((r, i) => <span key={r} style={{ animationDelay: `${0.5 + i * 0.15}s` }}>{r}</span>)}
      </div>
      <div className="art-wire w2"><i /></div>
      <div className="art-row art-evidence">
        <div className="art-node"><small>Evidence</small><b>SerpApi</b><span>15 live candidates</span></div>
        <div className="art-node jev"><small>Verifier</small><b>TypeSafe Jev</b><span>rules on each requirement</span></div>
      </div>
      <div className="art-wire w3"><i /></div>
      <div className="art-row art-out">
        <span className="vpill ok">VERIFIED → may proceed</span>
        <span className="vpill warn">UNVERIFIED → human review</span>
        <span className="vpill bad">REJECTED → blocked</span>
      </div>
      <p className="art-caption">Illustration of the real pipeline</p>
    </div>
  )
}

export default function Landing() {
  return (
    <div className="landing">
      <header className="site-nav">
        <Logo />
        <nav className="site-links">
          <button onClick={() => scrollTo('product')}>Product</button>
          <button onClick={() => go('/app/playground')}>Playground</button>
          <button onClick={() => go('/app/developers')}>Developers</button>
        </nav>
        <div className="site-cta">
          <button className="btn ghost sm" onClick={() => go('/signin')}>Sign in</button>
          <button className="btn primary sm" onClick={() => go('/signup')}>Get started</button>
        </div>
      </header>

      <section className="l-hero">
        <div className="l-hero-copy enter">
          <span className="eyebrow">Action verification for AI agents</span>
          <h1>Agents act fast.<br /><em>ProofGate checks the proof first.</em></h1>
          <p className="lede">Before an agent books, buys or commits, ProofGate turns the request into explicit requirements, gathers live evidence, and has TypeSafe Jev rule on every one. Contradicted options are rejected. Uncertain ones go to a human. Only fully supported actions proceed.</p>
          <div className="l-ctas">
            <button className="btn primary" onClick={() => go('/app/playground')}>Open the Playground</button>
            <button className="btn secondary" onClick={() => go('/app/developers')}>Developer docs</button>
          </div>
          <p className="fine">Live use case in this build: hotel search with a simulated booking step — no real reservations or payments.</p>
        </div>
        <PipelineArt />
      </section>

      <section className="l-section" id="product">
        <span className="eyebrow">How it works</span>
        <h2>From a proposed action to an accountable decision.</h2>
        <div className="steps">
          {[
            ['Action', 'An agent or user proposes an action in plain language.'],
            ['Evidence', 'Requirements are extracted, then SerpApi gathers live candidates as evidence.'],
            ['Jev', 'TypeSafe Jev marks each requirement SATISFIED, CONTRADICTED or UNKNOWN.'],
            ['Decision', 'Deterministic policy: contradicted → rejected, unknown → review, all satisfied → verified.'],
            ['Approval', 'A person reviews open points before an unverified action is simulated.'],
          ].map(([t, d], i) => (
            <div className="step" key={t}><span className="step-n">{String(i + 1).padStart(2, '0')}</span><h3>{t}</h3><p>{d}</p></div>
          ))}
        </div>
      </section>

      <section className="l-section">
        <span className="eyebrow">Why it matters</span>
        <h2>Relevant isn’t the same as right.</h2>
        <div className="why">
          {[
            ['Traceable', 'Every run is stored with its requirements, candidates, verdicts and the reason for each one.'],
            ['Evidence-based', 'Decisions come from structured verdicts on real search data — never from free-form model text.'],
            ['Contradictions block', 'If evidence contradicts a hard requirement, the option is rejected and cannot proceed.'],
            ['Humans stay in charge', 'Unknowns are surfaced, not guessed. A person acknowledges them before anything is simulated.'],
          ].map(([t, d]) => <div className="why-card" key={t}><h3>{t}</h3><p>{d}</p></div>)}
        </div>
      </section>

      <section className="l-section preview-sec">
        <div>
          <span className="eyebrow">Product preview</span>
          <h2>See exactly why an option passed or failed.</h2>
          <p className="lede">The trace shows each requirement for each candidate. In this real Goa run, no hotel could be fully verified, so ProofGate flagged the best match for review instead of calling it a fit — and rejected four contradicted options.</p>
          <button className="btn secondary" onClick={() => go('/app/developers/trace')}>Inspect stored runs →</button>
        </div>
        <div className="preview card">
          <div className="pv-head"><b>How I verified this</b><small>modelled on run c28bb2b65036</small></div>
          <div className="req-chips">{['≤ Rs 10,000', 'Sleeps 2 guests', 'Beachfront', 'Breakfast included', 'Free cancellation'].map((r) => <span className="req-chip" key={r}>{r}</span>)}</div>
          {[
            ['Silver Sands Holiday Village', 'UNVERIFIED', ['ok', 'warn', 'warn', 'ok', 'warn']],
            ['BEACHOUSE beachfront cottages', 'UNVERIFIED', ['ok', 'warn', 'ok', 'ok', 'warn']],
            ['Sibaya Beach Resort', 'REJECTED', ['bad', 'warn', 'warn', 'ok', 'warn']],
          ].map(([n, s, cells]) => (
            <div className="pv-row" key={n as string}>
              <span className="pv-name">{n as string}</span>
              <span className="pv-cells">{(cells as string[]).map((c, i) => <span key={i} className={`cell ${c}`}>{c === 'ok' ? '✓' : c === 'bad' ? '✕' : '?'}</span>)}</span>
              <span className={`vpill ${s === 'REJECTED' ? 'bad' : 'warn'}`}>{s as string}</span>
            </div>
          ))}
          <div className="final warn"><span className="final-badge warn">◷ NEEDS REVIEW</span><div className="final-name">Silver Sands Holiday Village</div><p className="flag-intro">Guests, beachfront and cancellation remain unverified.</p></div>
        </div>
      </section>

      <section className="l-section dev-sec">
        <div className="dev-copy">
          <span className="eyebrow">For developers</span>
          <h2>One verification layer, several ways in.</h2>
          <ul className="ticks">
            <li><b>REST API</b> — FastAPI with typed models and live OpenAPI docs.</li>
            <li><b>Streaming trace</b> — Server-Sent Events for every pipeline stage.</li>
            <li><b>MCP adapter</b> — Python functions shaped as tools; server transport coming soon.</li>
          </ul>
          <button className="btn primary" onClick={() => go('/app/developers/api')}>Explore the API</button>
        </div>
        <div className="code"><div className="code-bar"><span>shell</span></div><pre><code>{`curl -s localhost:8000/v1/find-and-verify \\
  -H "Content-Type: application/json" \\
  -d '{"request": "Hotel in Goa under Rs 10,000,
       2 people, beachfront", "action": "book_hotel"}'

→ { "status": "needs_human_review",
    "attempts": [ { "candidate_id": "c3",
      "verification": { "overall_status": "UNVERIFIED" … } } ] }`}</code></pre></div>
      </section>

      <section className="l-final">
        <h2>Give your agent a reason to be trusted.</h2>
        <p>Try the live pipeline, then follow one decision all the way down to the evidence.</p>
        <div className="l-ctas center">
          <button className="btn primary" onClick={() => go('/signup')}>Get started</button>
          <button className="btn secondary" onClick={() => go('/app/playground')}>Open the Playground</button>
        </div>
      </section>

      <footer className="site-foot">
        <Logo />
        <span>Search finds candidates. ProofGate finds the one that actually fits.</span>
        <nav>
          <button onClick={() => go('/app/playground')}>Playground</button>
          <button onClick={() => go('/app/developers')}>Developers</button>
          <a href="http://localhost:8000/docs" target="_blank" rel="noreferrer">API docs</a>
        </nav>
      </footer>
    </div>
  )
}
