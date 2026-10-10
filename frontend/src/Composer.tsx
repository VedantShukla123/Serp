import { useEffect, useRef, useState } from 'react'
import { getRecognitionCtor, mergeTranscript, speechErrorMessage, type RecognitionCtor } from './speech'

/* Message input shared by the Assistant and the Playground.
   Voice: browser Web Speech API only. Dictation is placed in the input for review and
   is NEVER submitted automatically — the user still presses Enter or Send. */

type VoiceState = 'idle' | 'listening' | 'stopped' | 'error' | 'unsupported'

export default function Composer({ value, onChange, onSubmit, disabled, placeholder, size = 'md' }: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  disabled?: boolean
  placeholder: string
  size?: 'md' | 'lg'
}) {
  const ctor = useRef<RecognitionCtor | null>(typeof window === 'undefined' ? null : getRecognitionCtor(window))
  const rec = useRef<InstanceType<RecognitionCtor> | null>(null)
  const baseRef = useRef('')          // input text when dictation started
  const valueRef = useRef(value)
  valueRef.current = value
  const [voice, setVoice] = useState<VoiceState>(ctor.current ? 'idle' : 'unsupported')
  const [note, setNote] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => { rec.current?.abort() }, [])

  function startVoice() {
    if (!ctor.current) {
      setVoice('unsupported')
      setNote('Voice input isn’t supported in this browser — try Chrome or Edge, or keep typing.')
      return
    }
    const r = new ctor.current()
    r.lang = navigator.language || 'en-US'
    r.continuous = false
    r.interimResults = true
    baseRef.current = valueRef.current
    r.onresult = (e) => {
      let text = ''
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
      onChange(mergeTranscript(baseRef.current, text))
    }
    r.onerror = (e) => {
      setVoice(e.error === 'aborted' ? 'stopped' : 'error')
      setNote(speechErrorMessage(e.error))
    }
    r.onend = () => {
      rec.current = null
      setVoice((v) => (v === 'listening' ? 'stopped' : v))
      setNote((n) => n ?? 'Recording stopped — review or edit the text, then press Send.')
      inputRef.current?.focus()
    }
    rec.current = r
    setNote(null)
    setVoice('listening')
    try { r.start() } catch { setVoice('error'); setNote(speechErrorMessage('unknown')) }
  }

  function stopVoice() {
    rec.current?.stop()
  }

  const listening = voice === 'listening'
  return (
    <div className={`composer ${size}`}>
      <div className={'input-pill' + (listening ? ' listening' : '')}>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!disabled && value.trim()) onSubmit() } }}
          placeholder={listening ? 'Listening… speak your request' : placeholder}
          aria-label={placeholder}
        />
        <button
          type="button"
          className={'mic' + (listening ? ' on' : '') + (voice === 'unsupported' ? ' off' : '')}
          onClick={listening ? stopVoice : startVoice}
          aria-pressed={listening}
          aria-label={listening ? 'Stop voice input' : 'Start voice input'}
          title={voice === 'unsupported' ? 'Voice input is not supported in this browser' : listening ? 'Stop recording' : 'Dictate (nothing is sent until you press Send)'}
        >
          {listening && <span className="mic-ring" aria-hidden />}
          <svg viewBox="0 0 24 24" aria-hidden><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.9" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>
        </button>
        <button className="send" onClick={onSubmit} disabled={disabled || !value.trim()} aria-label="Send">
          <svg viewBox="0 0 24 24" aria-hidden><path d="M12 19V5m0 0l-6 6m6-6l6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      <div className="voice-note" role="status" aria-live="polite">
        {listening ? <><span className="rec-dot" aria-hidden /> Listening — click the mic to stop. Nothing is sent until you press Send.</> : note}
      </div>
    </div>
  )
}
