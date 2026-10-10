/* REST API catalogue for the Developer Hub (no React) — unit-tested.
   Every entry mirrors a real route in app/main.py or app/api/routes.py and the Pydantic
   models in app/models/schemas.py. Examples are built per shell by devhub.example(). */
import type { Ex } from './devhub.ts'

export type Cost = 'free' | 'paid' | 'demo'
export type Field = { name: string; type: string; req?: boolean; note: string }
/** Run IDs used to make copied examples runnable on this machine. */
export type ExampleIds = { anyRun: string; hotelRun: string; hotelCand: string; productRun: string; productCand: string }
export type Endpoint = {
  method: 'GET' | 'POST'; path: string; purpose: string; cost: Cost
  inputs?: Field[]; returns: string; errors: string[]
  ex?: (ids: ExampleIds) => Ex
  exNote?: string
}
export type Group = { id: string; title: string; items: Endpoint[] }

export const COST: Record<Cost, { label: string; short: string; cls: string; note: string }> = {
  free: { label: 'Free', short: 'FREE', cls: 'ok', note: 'Free — reads local data or service status. No search, no external calls.' },
  paid: { label: 'Uses API credits', short: 'USES CREDITS', cls: 'warn', note: 'Uses API credits — calls SerpApi, your LLM and/or TypeSafe Jev when you run it.' },
  demo: { label: 'Demo only', short: 'DEMO ONLY', cls: 'violet', note: 'Demo only — local simulated records. Nothing is booked, bought or charged; no external calls.' },
}

const RUN_FIELDS = 'run_id, status, request, target_type, requirements, candidate_count, ranked_candidates, selected_candidate, verification, attempts, timing_ms, errors'

export const GROUPS: Group[] = [
  { id: 'service', title: 'Service and health', items: [
    { method: 'GET', path: '/health', cost: 'free', purpose: 'Is the backend up, and are its API keys configured?',
      returns: '{ ok, service, ready, missing_credentials: [key names only], has_serpapi_key, has_llm_key, has_jev }',
      errors: ['No error codes — "ready": false lists the missing key names.'], ex: () => ({ method: 'GET', path: '/health' }) },
  ] },
  { id: 'runs', title: 'Runs and evidence', items: [
    { method: 'GET', path: '/v1/runs', cost: 'free', purpose: 'List recent stored runs, newest first.',
      inputs: [{ name: 'limit', type: 'query int', note: 'Default 50, clamped to 1–200.' }],
      returns: '[{ run_id, created_at, request }]', errors: ['422 if limit is not an integer'],
      ex: () => ({ method: 'GET', path: '/v1/runs?limit=5', table: ['run_id', 'created_at', 'request'] }) },
    { method: 'GET', path: '/v1/runs/{run_id}', cost: 'free', purpose: 'Everything stored for one run.',
      returns: `{ ${RUN_FIELDS}, candidates, raw_serpapi }`, errors: ['404 {"detail": "run not found"}'],
      ex: (i) => ({ method: 'GET', path: `/v1/runs/${i.anyRun}` }) },
    { method: 'GET', path: '/v1/runs/{run_id}/evidence', cost: 'free', purpose: 'Just the evidence behind a run.',
      returns: '{ run_id, candidates, raw_serpapi, attempts }', errors: ['404 {"detail": "run not found"}'],
      ex: (i) => ({ method: 'GET', path: `/v1/runs/${i.anyRun}/evidence` }) },
  ] },
  { id: 'verify', title: 'Search and verification', items: [
    { method: 'POST', path: '/v1/find-and-verify', cost: 'paid', purpose: 'Run the full pipeline for one request and store the run.',
      inputs: [
        { name: 'request', type: 'string', req: true, note: 'What to find, with its hard requirements.' },
        { name: 'action', type: 'string', note: 'Default "search". e.g. book_hotel, buy_laptop.' },
        { name: 'max_candidates', type: 'int', note: 'Default 15.' },
        { name: 'engine', type: 'string | null', note: 'Force a SerpApi engine, e.g. google_hotels.' },
      ],
      returns: `{ ${RUN_FIELDS} } — status: verified · needs_human_review · no_verified_match`,
      errors: ['422 missing request', '502 missing API key or upstream failure', '500 unexpected pipeline failure'],
      ex: () => ({ method: 'POST', path: '/v1/find-and-verify', body: { request: 'Hotel in Goa under Rs 10,000 for 2 people, beachfront, free cancellation', action: 'book_hotel', max_candidates: 5 } }) },
    { method: 'POST', path: '/v1/verify', cost: 'paid', purpose: 'Check one candidate you supply against your requirements (no search).',
      inputs: [
        { name: 'requirements', type: 'array', req: true, note: '[{ id, description, type?, importance?: "required" | "preferred" }]' },
        { name: 'candidate', type: 'object', req: true, note: '{ candidate_id, name, …any candidate fields }' },
      ],
      returns: '{ candidate_id, overall_status: VERIFIED · UNVERIFIED · REJECTED, requirements: [{ requirement_id, status, reason, supporting_data, confidence }], verifier }',
      errors: ['422 invalid body', '502 jev_failed (missing key or upstream failure)'],
      ex: () => ({ method: 'POST', path: '/v1/verify', body: {
        requirements: [{ id: 'budget', description: 'Price per night must be under Rs 10,000' }, { id: 'beachfront', description: 'Must be beachfront' }],
        candidate: { candidate_id: 'c1', name: 'Example Beach Resort', price: 'Rs 6,500 per night', description: 'Beachfront resort with private beach access' } } }) },
  ] },
  { id: 'chat', title: 'Agent chat and streaming', items: [
    { method: 'POST', path: '/v1/agent/chat', cost: 'paid', purpose: 'One chat turn; searches and verifies when the message needs live data.',
      inputs: [{ name: 'message', type: 'string', req: true, note: 'Must not be empty.' }, { name: 'session_id', type: 'string', note: 'Send back the returned value to continue.' }],
      returns: '{ reply, status ("direct" if no search), run_id, target_type, selected_candidate, verification, attempts, session_id }',
      errors: ['422 empty message', '502 upstream failure', '500 unexpected failure'],
      ex: () => ({ method: 'POST', path: '/v1/agent/chat', body: { message: 'Hotel in Goa under Rs 10,000 for 2 people, beachfront' } }) },
    { method: 'GET', path: '/v1/agent/chat/stream', cost: 'paid', purpose: 'The same turn as a live Server-Sent Events stream.',
      inputs: [{ name: 'message', type: 'query string', req: true, note: 'URL-encoded.' }, { name: 'session_id', type: 'query string', note: 'Optional.' }],
      returns: 'SSE events: status, requirements, searching, candidates, ranking, verifying, verdict, final (includes target_type)',
      errors: ['422 empty message', 'Upstream failures arrive as an {"type": "error"} event, not an HTTP error'],
      ex: () => ({ method: 'GET', path: '/v1/agent/chat/stream?message=Hotel%20in%20Goa%20under%20Rs%2010000%20for%202%20people', stream: true }) },
  ] },
  { id: 'actions', title: 'Simulated bookings and orders', items: [
    { method: 'GET', path: '/v1/runs/{run_id}/candidates/{candidate_id}/action-context', cost: 'demo', purpose: 'Which action fits a candidate: hotel booking, product order or review only.',
      returns: '{ target_type: hotel · product · place · generic, action: { kind, label, supported }, …hotel or product context }',
      errors: ['404 run or candidate not found'], ex: (i) => ({ method: 'GET', path: `/v1/runs/${i.productRun}/candidates/${i.productCand}/action-context` }) },
    { method: 'GET', path: '/v1/runs/{run_id}/candidates/{candidate_id}/booking-context', cost: 'demo', purpose: 'Hotels only: details, listed prices and Jev status for one candidate.',
      returns: '{ hotel, price (per night + listed total; unknown = null), verification_status, unresolved_requirements, contradicted_requirements, bookable, requires_acknowledgement }',
      errors: ['404 run or candidate not found', '409 wrong_action_type (not a hotel)'],
      ex: (i) => ({ method: 'GET', path: `/v1/runs/${i.hotelRun}/candidates/${i.hotelCand}/booking-context` }) },
    { method: 'POST', path: '/v1/bookings/preview', cost: 'demo', purpose: 'Hotels: validate guest details and preview the simulated booking. Saves nothing.',
      inputs: [
        { name: 'run_id, candidate_id', type: 'string', req: true, note: 'Which hotel — prices come from the stored run, never the client.' },
        { name: 'guest_name, email', type: 'string', req: true, note: '' },
        { name: 'guests', type: 'int 1–10', req: true, note: '' },
        { name: 'check_in, check_out', type: 'YYYY-MM-DD', req: true, note: 'Not in the past; at most 30 nights.' },
      ],
      returns: '{ …booking context, guest, estimated_total, estimated_total_note }',
      errors: ['404 not found', '409 candidate_rejected', '409 wrong_action_type', '422 invalid_booking_details (per-field errors)'],
      ex: (i) => ({ method: 'POST', path: '/v1/bookings/preview', body: { run_id: i.hotelRun, candidate_id: i.hotelCand, guest_name: 'Demo Guest', email: 'demo@example.com', guests: 2, check_in: '2030-01-10', check_out: '2030-01-12' } }) },
    { method: 'POST', path: '/v1/bookings', cost: 'demo', purpose: 'Hotels: create a SIM- booking record.',
      inputs: [{ name: '…same as preview', type: '', req: true, note: '' }, { name: 'acknowledge_unverified', type: 'bool', note: 'Must be true when the hotel is not VERIFIED.' }],
      returns: '{ …preview, booking_id: "SIM-…", status: "SIMULATED_CONFIRMED", simulated: true, created_at }',
      errors: ['409 candidate_rejected', '409 acknowledgement_required', '409 wrong_action_type', '404 / 422 as preview'],
      exNote: 'Running this writes a demo booking record to your local database.',
      ex: (i) => ({ method: 'POST', path: '/v1/bookings', body: { run_id: i.hotelRun, candidate_id: i.hotelCand, guest_name: 'Demo Guest', email: 'demo@example.com', guests: 2, check_in: '2030-01-10', check_out: '2030-01-12', acknowledge_unverified: true } }) },
    { method: 'GET', path: '/v1/bookings/{booking_id}', cost: 'demo', purpose: 'Read back a simulated booking.', returns: 'The stored booking record.', errors: ['404 booking not found'],
      exNote: 'Use the booking_id returned by POST /v1/bookings.' },
    { method: 'POST', path: '/v1/orders/preview', cost: 'demo', purpose: 'Products: validate buyer details and preview the simulated order. Saves nothing.',
      inputs: [
        { name: 'run_id, candidate_id', type: 'string', req: true, note: 'Which product — price comes from the stored run, never the client.' },
        { name: 'buyer_name, email', type: 'string', req: true, note: '' },
        { name: 'quantity', type: 'int 1–10', req: true, note: '' },
        { name: 'delivery_address', type: 'string', req: true, note: 'Demo only; never sent anywhere.' },
      ],
      returns: '{ product, price (as listed, never converted), buyer, subtotal (null unless price and currency are reliable), subtotal_note }',
      errors: ['404 not found', '409 candidate_rejected', '409 wrong_action_type', '422 invalid_order_details'],
      ex: (i) => ({ method: 'POST', path: '/v1/orders/preview', body: { run_id: i.productRun, candidate_id: i.productCand, buyer_name: 'Demo Buyer', email: 'demo@example.com', quantity: 1, delivery_address: '12 MG Road, Bengaluru' } }) },
    { method: 'POST', path: '/v1/orders', cost: 'demo', purpose: 'Products: create a SIM-ORDER- record.',
      inputs: [{ name: '…same as preview', type: '', req: true, note: '' }, { name: 'acknowledge_unverified', type: 'bool', note: 'Must be true when the product is not VERIFIED.' }],
      returns: '{ …preview, order_id: "SIM-ORDER-…", status: "SIMULATED_ORDER_CONFIRMED", simulated: true, created_at }',
      errors: ['409 candidate_rejected', '409 acknowledgement_required', '409 wrong_action_type', '404 / 422 as preview'],
      exNote: 'Running this writes a demo order record to your local database.',
      ex: (i) => ({ method: 'POST', path: '/v1/orders', body: { run_id: i.productRun, candidate_id: i.productCand, buyer_name: 'Demo Buyer', email: 'demo@example.com', quantity: 1, delivery_address: '12 MG Road, Bengaluru', acknowledge_unverified: true } }) },
    { method: 'GET', path: '/v1/orders/{order_id}', cost: 'demo', purpose: 'Read back a simulated order.', returns: 'The stored order record.', errors: ['404 order not found'],
      exNote: 'Use the order_id returned by POST /v1/orders.' },
  ] },
]

/** Stable, URL-safe key, e.g. "post-v1-find-and-verify". Used for deep links. */
export function epKey(e: Pick<Endpoint, 'method' | 'path'>): string {
  return `${e.method}-${e.path}`.toLowerCase().replace(/[{}]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Text + cost filter. Empty groups are dropped. */
export function filterGroups(groups: Group[], query: string, cost: Cost | 'all'): Group[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return groups
    .map((g) => ({ ...g, items: g.items.filter((e) => {
      if (cost !== 'all' && e.cost !== cost) return false
      // the endpoint's own text only — a group title like "bookings and orders" would over-match
      const hay = `${e.method} ${e.path} ${e.purpose} ${COST[e.cost].label}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    }) }))
    .filter((g) => g.items.length > 0)
}

export const PLACEHOLDER_IDS: ExampleIds = { anyRun: 'PASTE_RUN_ID', hotelRun: 'PASTE_HOTEL_RUN_ID', hotelCand: 'PASTE_CANDIDATE_ID', productRun: 'PASTE_PRODUCT_RUN_ID', productCand: 'PASTE_CANDIDATE_ID' }
