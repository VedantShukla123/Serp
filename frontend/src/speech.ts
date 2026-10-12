/* Browser speech-to-text helpers (no React) — unit-tested with `node --test`.
   Uses only the built-in Web Speech API; nothing is sent to a ProofGate server. */

export type RecognitionCtor = new () => {
  lang: string; continuous: boolean; interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void; stop(): void; abort(): void
}

/** SpeechRecognition constructor (standard or webkit-prefixed), or null when unsupported. */
export function getRecognitionCtor(w: unknown): RecognitionCtor | null {
  if (!w || typeof w !== 'object') return null
  const o = w as Record<string, unknown>
  const c = o.SpeechRecognition ?? o.webkitSpeechRecognition
  return typeof c === 'function' ? (c as RecognitionCtor) : null
}

export function speechErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was blocked. Allow it in your browser settings, or keep typing.'
    case 'no-speech':
      return 'No speech detected — try again closer to the microphone.'
    case 'audio-capture':
      return 'No microphone was found.'
    case 'network':
      return 'Speech recognition needs a network connection in this browser.'
    case 'aborted':
      return 'Recording stopped.'
    default:
      return 'Voice input failed — you can still type your request.'
  }
}

/** Append dictated text to whatever is already in the input (never replaces typed text). */
export function mergeTranscript(base: string, spoken: string): string {
  const s = spoken.trim()
  if (!s) return base
  const b = base.replace(/\s+$/, '')
  return b ? `${b} ${s}` : s
}
