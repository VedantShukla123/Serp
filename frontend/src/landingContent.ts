/* Landing page content + destinations (no React) — unit-tested.
   Illustrative data is copied from a recorded development run (c28bb2b65036, Goa hotel search)
   and labelled as a recorded example; nothing here is presented as a live operation. That run
   is NOT on a fresh deployment, so no link points at it — the Trace Inspector opens the newest
   run that actually exists, or an empty state with a way to run a search. */

export const DEMO_RUN = 'c28bb2b65036'

/** Every landing-page destination. `scroll:` targets an id on the page; others are hash routes. */
export const LINKS = {
  navProduct: 'scroll:how',
  navPlayground: '/app/playground',
  navDevelopers: '/app/developers',
  navSignIn: '/signin',
  navGetStarted: '/signup',
  heroPrimary: '/app/playground',
  heroSecondary: 'scroll:how',
  previewRun: '/app/developers/trace',
  devRest: '/app/developers/api',
  devStream: '/app/developers/api/get-v1-agent-chat-stream',
  devMcp: '/app/developers/mcp',
  devSdks: '/app/developers/sdks',
  finalPrimary: '/app',
  finalSecondary: '/app/developers',
  footPlayground: '/app/playground',
  footDevelopers: '/app/developers',
  footSignIn: '/signin',
} as const

export type Verdict = 'S' | 'U' | 'C'

/* Silver Sands Holiday Village in run c28bb2b65036: budget S, guests U, beachfront U, breakfast S, cancellation U. */
export const REQS = ['≤ Rs 10,000', 'Sleeps 2 guests', 'Beachfront', 'Breakfast included', 'Free cancellation']
export const PICK = { name: 'Silver Sands Holiday Village', price: '₹1,694 / night', verdicts: ['S', 'U', 'U', 'S', 'U'] as Verdict[] }

export const STEPS = [
  { id: 'action', n: '01', title: 'An agent proposes an action', body: 'Your agent wants to book, buy or commit to something on a user’s behalf. ProofGate receives the request before anything happens.' },
  { id: 'reqs', n: '02', title: 'Hard requirements are extracted', body: 'An LLM turns the request into explicit, checkable conditions — budget, guests, location, inclusions, policy.' },
  { id: 'evidence', n: '03', title: 'Live evidence is gathered', body: 'SerpApi searches the web and returns real candidates. Their listed facts become the evidence for every decision.' },
  { id: 'jev', n: '04', title: 'TypeSafe Jev rules on each condition', body: 'Every requirement is marked SATISFIED, UNKNOWN or CONTRADICTED from the evidence — never guessed.' },
  { id: 'decision', n: '05', title: 'A fixed policy makes the call', body: 'Code, not free-form model text: any contradiction rejects, any unknown needs review, only all-satisfied verifies.' },
  { id: 'review', n: '06', title: 'A person reviews when it matters', body: 'Unconfirmed points are shown to a human, who must acknowledge them before an action can proceed — here, as a simulation.' },
] as const

export const OUTCOMES = [
  { id: 'ok', status: 'VERIFIED', marks: ['S', 'S', 'S'] as Verdict[], line: 'Every required point is satisfied.', then: 'May proceed' },
  { id: 'warn', status: 'UNVERIFIED', marks: ['S', 'U', 'S'] as Verdict[], line: 'One required point can’t be confirmed.', then: 'A person reviews first' },
  { id: 'bad', status: 'REJECTED', marks: ['S', 'C', 'U'] as Verdict[], line: 'One required point is contradicted.', then: 'Blocked' },
] as const

/** Overall status from required verdicts — the same rule as app/services/jev_verifier.overall_status. */
export function overall(marks: readonly Verdict[]): 'VERIFIED' | 'UNVERIFIED' | 'REJECTED' {
  if (marks.includes('C')) return 'REJECTED'
  if (marks.includes('U')) return 'UNVERIFIED'
  return 'VERIFIED'
}

/** Index of the step closest to the viewport centre, given each step's visible ratio (ties → earlier). */
export function mostVisible(ratios: number[], current: number): number {
  let best = current, top = -1
  ratios.forEach((r, i) => { if (r > top + 1e-6) { top = r; best = i } })
  return top > 0 ? best : current
}
