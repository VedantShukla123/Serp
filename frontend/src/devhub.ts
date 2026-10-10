/* Developer Hub logic (no React) — unit-tested with `node --test`.
   Sources of truth: app/api/routes.py, app/models/schemas.py, app/mcp/adapter.py, run.py. */

/* API location. Set VITE_API_BASE_URL at build time (e.g. https://api.example.com) when the
   frontend and backend are on different origins. Unset = same origin: in development the Vite
   proxy forwards /v1 and /health to http://localhost:8000. Never put secrets in VITE_ vars. */
const ENV_BASE = String(import.meta.env?.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')
/** Prefix for browser API calls ('' = same origin). */
export const API_ORIGIN = ENV_BASE
/** Absolute base shown in docs, examples and links. */
export const API_BASE = ENV_BASE || 'http://localhost:8000'
/** Full URL for an API path such as '/v1/runs'. */
export function apiUrl(path: string, origin: string = API_ORIGIN): string {
  return origin.replace(/\/+$/, '') + path
}

/* ---------- capability status taxonomy (five distinct meanings) ---------- */
export type Avail = 'now' | 'inproc' | 'demo' | 'soon' | 'none'
export const AVAIL: Record<Avail, { label: string; icon: string; tone: 'ok' | 'violet' | 'warn' | 'soon' | 'bad'; meaning: string }> = {
  now: { label: 'Available now', icon: '●', tone: 'ok', meaning: 'Works today against your local ProofGate (HTTP or stdio).' },
  inproc: { label: 'In-process only', icon: '◐', tone: 'violet', meaning: 'Works today from a local copy of this repository (Python), not over HTTP.' },
  demo: { label: 'Demo only', icon: '◇', tone: 'warn', meaning: 'Works for demonstration; not real (e.g. simulated bookings).' },
  soon: { label: 'Coming soon', icon: '○', tone: 'soon', meaning: 'Planned. Not in this repository yet.' },
  none: { label: 'Not available', icon: '✕', tone: 'bad', meaning: 'Not built and not part of this demo.' },
}

/* ---------- copy-paste examples: one definition, two shells ---------- */
export type Shell = 'bash' | 'powershell'
/** `table`: columns for endpoints that return a JSON array (PowerShell prints a table). */
export type Ex = { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown>; stream?: boolean; table?: string[] }

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`          // bash single-quote
const psStr = (s: string) => `"${s.replace(/[`"$]/g, (c) => '`' + c)}"` // PowerShell double-quote

function psValue(v: unknown, indent: string): string {
  if (Array.isArray(v)) return `@(\n${v.map((x) => `${indent}  ${psValue(x, indent + '  ')}`).join(',\n')}\n${indent})`
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
    return `@{\n${entries.map(([k, x]) => `${indent}  ${k} = ${psValue(x, indent + '  ')}`).join('\n')}\n${indent}}`
  }
  if (typeof v === 'boolean') return v ? '$true' : '$false'
  if (typeof v === 'number') return String(v)
  if (v === null) return '$null'
  return psStr(String(v))
}

/** Every /v1 route except /v1/auth/* needs `Authorization: Bearer <token>` on a deployed server. */
export function needsToken(path: string): boolean {
  return path.startsWith('/v1/') && !path.startsWith('/v1/auth/')
}
/** Header lines the examples use; the token comes from loginExample() (a local dev server ignores it). */
const BASH_AUTH = `-H "Authorization: Bearer $PROOFGATE_TOKEN"`
const PS_AUTH = `-Headers @{ Authorization = "Bearer $env:PROOFGATE_TOKEN" }`
const CURL_EXE_AUTH = `-H "Authorization: Bearer $env:PROOFGATE_TOKEN"`

/** Runnable command. POST bodies are real JSON in both shells; protected routes send the token. */
export function example(ex: Ex, shell: Shell): string {
  const url = API_BASE + ex.path
  const auth = needsToken(ex.path)
  if (shell === 'bash') {
    const h = auth ? ` ${BASH_AUTH}` : ''
    if (ex.stream) return `curl -N${h} ${q(url)}`
    if (ex.method === 'GET') return `curl -s${h} ${q(url)}`
    return `curl -s -X POST ${q(url)} \\\n${auth ? `  ${BASH_AUTH} \\\n` : ''}  -H 'Content-Type: application/json' \\\n  -d ${q(JSON.stringify(ex.body ?? {}, null, 2))}`
  }
  // Windows PowerShell 5.1: `curl` is an alias for Invoke-WebRequest and curl.exe strips
  // JSON quotes, so use Invoke-RestMethod + ConvertTo-Json (curl.exe only for SSE streams).
  const h = auth ? ` ${PS_AUTH}` : ''
  if (ex.stream) return `curl.exe -N${auth ? ` ${CURL_EXE_AUTH}` : ''} ${psStr(url)}`
  // PS 5.1 wraps JSON arrays as {value, Count} when converting back to JSON; show a table instead.
  if (ex.table) return `(Invoke-RestMethod ${psStr(url)}${h}) | Format-Table ${ex.table.join(', ')} -AutoSize`
  // -InputObject keeps JSON arrays as arrays (piping wraps them as {value, Count} in PS 5.1).
  if (ex.method === 'GET') return `$res = Invoke-RestMethod ${psStr(url)}${h}\nConvertTo-Json -Depth 10 -InputObject $res`
  return `$body = ${psValue(ex.body ?? {}, '')} | ConvertTo-Json -Depth 10\n$res = Invoke-RestMethod -Method Post -Uri ${psStr(url)}${h} \`\n  -ContentType "application/json" -Body $body\nConvertTo-Json -Depth 10 -InputObject $res`
}

/** Demo sign-in: prompts for the shared demo password (never written into the command) and stores
    the short-lived token from POST /v1/auth/login in PROOFGATE_TOKEN for the other examples. */
export function loginExample(shell: Shell): string {
  const url = API_BASE + '/v1/auth/login'
  if (shell === 'bash') return [
    `read -rsp 'Demo password: ' PG_PW; echo`,
    `export PROOFGATE_TOKEN=$(PG_PW="$PG_PW" python -c 'import json,os; print(json.dumps({"password": os.environ["PG_PW"]}))' \\`,
    `  | curl -s -X POST ${q(url)} -H 'Content-Type: application/json' -d @- \\`,
    `  | python -c 'import json,sys; print(json.load(sys.stdin)["token"])')`,
    `unset PG_PW`,
  ].join('\n')
  return [
    `$pw = Read-Host 'Demo password' -AsSecureString`,
    `$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))`,
    `$env:PROOFGATE_TOKEN = (Invoke-RestMethod -Method Post -Uri ${psStr(url)} \``,
    `  -ContentType "application/json" -Body (@{ password = $plain } | ConvertTo-Json)).token`,
    `Remove-Variable plain, pw`,
  ].join('\n')
}

/** The JSON a bash example sends (used by tests to prove the payload is valid). */
export function bashPayload(cmd: string): unknown {
  const m = cmd.match(/-d '([\s\S]*)'$/)
  return m ? JSON.parse(m[1].replace(/'\\''/g, "'")) : null
}

/* ---------- run ids ---------- */
/** Pipeline run ids are 12 hex chars (uuid4().hex[:12]); allow any safe id but explain the format. */
export function checkRunId(raw: string): { ok: true; id: string } | { ok: false; message: string } {
  const id = raw.trim()
  if (!id) return { ok: false, message: 'Enter a run ID, e.g. c28bb2b65036 (copy one from the list).' }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, message: 'Run IDs only contain letters, numbers, - and _ (pipeline IDs are 12 hex characters).' }
  return { ok: true, id }
}

/* ---------- request errors ---------- */
export type LoadError = { kind: 'not_found' | 'server' | 'http' | 'network' | 'timeout'; title: string; detail: string }

export function describeError(e: unknown, status?: number): LoadError {
  if (status === 404) return { kind: 'not_found', title: 'Run not found', detail: 'No stored run has this ID. Check for typos, or pick one from the list.' }
  if (status && status >= 500) return { kind: 'server', title: `Server error (HTTP ${status})`, detail: 'The API failed while reading this run. Check the backend terminal for the error.' }
  if (status) return { kind: 'http', title: `Request failed (HTTP ${status})`, detail: 'The API rejected the request.' }
  if (e instanceof DOMException && e.name === 'AbortError') return { kind: 'timeout', title: 'Request timed out', detail: 'The API did not answer in time. Is the backend still running?' }
  return { kind: 'network', title: 'Cannot reach the API', detail: 'Start it with `python run.py --serve` (port 8000) and keep `npm run dev` running.' }
}

/** Only the most recent request may update the UI (older responses are ignored). */
export function latestGuard() {
  let current = 0
  return { next: () => ++current, isCurrent: (token: number) => token === current }
}

/* ---------- trace rows, keyed by candidate_id ---------- */
export type StoredVerdict = { requirement_id: string; status: string; reason?: string; confidence?: number | null; supporting_data?: string | null }
export type StoredCandidate = {
  candidate_id: string; name?: string; title?: string; price?: unknown; price_value?: number | null; currency?: string
  rating?: number | null; review_count?: number | null; location?: string; address?: string; cancellation_info?: string
  source_url?: string; booking_url?: string; amenities?: string[]
}
export type StoredRunDoc = {
  run_id: string; status: string; request: string; created_at?: string; candidate_count?: number
  requirements?: { id: string; description: string; importance?: string }[]
  candidates?: StoredCandidate[]
  ranked_candidates?: { candidate_id: string; rank: number; reason?: string }[]
  attempts?: { candidate_id: string; candidate_name?: string; verification: { overall_status: string; requirements: StoredVerdict[]; verifier?: string } }[]
  selected_candidate?: StoredCandidate | null
  verification?: { overall_status: string } | null
  errors?: string[]
  serpapi_meta?: Record<string, unknown>
  timing_ms?: Record<string, number>
}

export type TraceRow = {
  candidate_id: string; rank: number | null; name: string
  status: 'VERIFIED' | 'UNVERIFIED' | 'REJECTED' | 'NOT_CHECKED' | string
  verdicts: Record<string, StoredVerdict>; verifier: string | null
  evidence: StoredCandidate | null
}

export function traceRows(doc: StoredRunDoc): TraceRow[] {
  const cands = new Map((doc.candidates ?? []).map((c) => [c.candidate_id, c]))
  const attempts = new Map((doc.attempts ?? []).map((a) => [a.candidate_id, a]))
  const row = (cid: string, rank: number | null): TraceRow => {
    const a = attempts.get(cid)
    const c = cands.get(cid) ?? null
    return {
      candidate_id: cid, rank,
      name: c?.name || c?.title || (a?.candidate_name && a.candidate_name !== cid ? a.candidate_name : cid),
      status: a ? a.verification.overall_status : 'NOT_CHECKED',
      verdicts: Object.fromEntries((a?.verification.requirements ?? []).map((v) => [v.requirement_id, v])),
      verifier: a?.verification.verifier ?? null,
      evidence: c,
    }
  }
  const ranked = [...(doc.ranked_candidates ?? [])].sort((x, y) => x.rank - y.rank)
  const seen = new Set(ranked.map((r) => r.candidate_id))
  // Attempts or candidates the ranking does not mention are still shown (unranked), never dropped.
  const extra = [...attempts.keys(), ...cands.keys()].filter((id, i, all) => !seen.has(id) && all.indexOf(id) === i)
  return [...ranked.map((r) => row(r.candidate_id, r.rank)), ...extra.map((id) => row(id, null))]
}

export function statusCounts(rows: TraceRow[]) {
  const c = { VERIFIED: 0, UNVERIFIED: 0, REJECTED: 0, NOT_CHECKED: 0 }
  for (const r of rows) if (r.status in c) c[r.status as keyof typeof c]++
  return c
}

export const RUN_STATUS_TEXT: Record<string, string> = {
  verified: 'A candidate met every required point.',
  needs_human_review: 'Nothing was fully verified — the best match is returned for a person to review.',
  no_verified_match: 'No candidates could be selected.',
  error: 'The run failed.',
}

/* ---------- Trace inspector list helpers ---------- */
export const RUNS_PAGE = 8

/** "c28bb2b6…" for 12-char pipeline ids; shorter ids are shown whole. */
export function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id
}

/** Which run to open when the inspector has no selection: the newest stored run, or none. */
export function initialRun(selected: string | null, rows: { run_id: string }[]): string | null {
  if (selected) return null           // the URL already chose one
  return rows[0]?.run_id ?? null
}

/** Ids among the visible rows whose status has not been fetched yet (statuses come from run details only). */
export function missingStatus(rows: { run_id: string }[], shown: number, known: Record<string, unknown>): string[] {
  return rows.slice(0, shown).map((r) => r.run_id).filter((id) => !(id in known))
}
