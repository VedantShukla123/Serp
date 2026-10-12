import { useEffect, useRef, useState } from 'react'
import roboUrl from './assets/robo.png'
import RoboViewer from './RoboViewer'
import Composer from './Composer'
import { TraceView } from './Trace'
import type { useAgentChat } from './chat'

export const EXAMPLES = [
  'Find me a hotel in Goa under Rs 10,000 for 2 people, beachfront, with breakfast included and free cancellation.',
  'Laptop under Rs 90,000, 32GB RAM, OLED display',
  'What can you verify for me?',
]

export default function Assistant({ chat }: { chat: ReturnType<typeof useAgentChat> }) {
  const { messages, sending, send, patchTrace } = chat
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, sending])

  function submit(text = input) {
    if (!text.trim() || sending) return
    setInput('')
    void send(text)
  }

  const empty = messages.length === 0
  return (
    <div className="assistant">
      <div className="pg-scroll" ref={scrollRef}>
        <div className="pg-canvas">
          {empty && (
            <section className="hero enter">
              <div className="hero-glow" />
              <div className="hero-3d-canvas"><RoboViewer /></div>
              <span className="eyebrow">Assistant</span>
              <h1>Ask for something that needs a <em>verified</em> answer.</h1>
              <p>ProofGate searches live, ranks candidates, and checks every hard requirement with Jev before anything is called a fit.</p>
            </section>
          )}

          {messages.map((m) =>
            m.role === 'user' ? (
              <div className="row user-row enter" key={m.id}>
                <div className="bubble user">{m.text}</div>
              </div>
            ) : (
              <div className="row agent-row enter" key={m.id}>
                <img className="avatar" src={roboUrl} alt="" />
                <div className="bubble agent">
                  {m.live && !m.text ? <span className="typing" aria-label="Working"><i /><i /><i /></span> : <p className="reply">{m.text}</p>}
                  {m.live && m.trace?.statusLine && <div className="stage-line"><span className="spinner" />{m.trace.statusLine}</div>}
                  {m.trace && <TraceView trace={m.trace} onToggle={() => patchTrace(m.id, (t) => ({ ...t, open: !t.open }))} />}
                  {m.notice && <div className="contract-note">{m.notice}</div>}
                </div>
              </div>
            ),
          )}
          <div style={{ height: 8 }} />
        </div>
      </div>
      <footer className="pg-dock">
        {empty && (
          <div className="chips">
            {EXAMPLES.map((ex) => (
              <button key={ex} className="chip" onClick={() => setInput(ex)} title="Insert into the input — press Send to run">{ex}</button>
            ))}
          </div>
        )}
        <Composer value={input} onChange={setInput} onSubmit={() => submit()} disabled={sending}
          placeholder="Ask anything that needs a verified answer…" />
      </footer>
    </div>
  )
}
