/* Action / target type on the client (mirrors app/services/actions.py) — unit-tested.
   The backend's action-context endpoint stays the authority; this only picks labels
   and routes the UI. Unknown types never fall back to a hotel booking. */

export type TargetType = 'hotel' | 'product' | 'place' | 'generic'

const ENGINE_TARGET: Record<string, TargetType> = {
  google_hotels: 'hotel',
  google_shopping: 'product',
  google_maps: 'place',
}

export function targetTypeOf(src: { target_type?: string | null; engine?: string | null; action?: string | null }): TargetType | null {
  const t = src.target_type
  if (t === 'hotel' || t === 'product' || t === 'place' || t === 'generic') return t
  if (src.engine) return ENGINE_TARGET[src.engine] ?? 'generic'
  const a = (src.action ?? '').toLowerCase()
  if (a === 'book_hotel') return 'hotel'
  if (a.startsWith('buy_')) return 'product'
  return null   // unknown: the modal asks the backend; nothing assumes a hotel
}

/** Button text for a candidate. Status rules are enforced server-side as well. */
export function actionLabel(target: TargetType | null, status: string): { text: string; enabled: boolean } {
  const s = status.toUpperCase()
  if (s === 'REJECTED') return { text: 'Rejected — not available', enabled: false }
  const review = s === 'VERIFIED' ? '' : ' (needs review)'
  if (target === 'hotel') return { text: `Simulate hotel booking${review}`, enabled: true }
  if (target === 'product') return { text: `Simulate order${review}`, enabled: true }
  return { text: 'Review result', enabled: true }
}

/* ---------- product order form (mirrors app/services/orders.py validation) ---------- */
export const ORDER_DISCLAIMER = 'SIMULATED ORDER — NO REAL PURCHASE — NO PAYMENT CHARGED'
export const MAX_QUANTITY = 10

export type OrderForm = { buyer_name: string; email: string; quantity: string; delivery_address: string }
export type OrderErrors = Partial<Record<keyof OrderForm, string>>

export function validateOrderForm(f: OrderForm): OrderErrors {
  const e: OrderErrors = {}
  if (!f.buyer_name.trim()) e.buyer_name = 'Buyer name is required.'
  else if (f.buyer_name.trim().length > 100) e.buyer_name = 'Buyer name is too long.'
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) e.email = 'Enter a valid email address.'
  const q = Number(f.quantity)
  if (!f.quantity.trim() || !Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) e.quantity = `Quantity must be between 1 and ${MAX_QUANTITY}.`
  const a = f.delivery_address.trim()
  if (a.length < 5) e.delivery_address = 'Enter delivery details (demo only — never sent anywhere).'
  else if (a.length > 300) e.delivery_address = 'Delivery details are too long.'
  return e
}

/** Money in the listing's own currency; never converted. Unknown stays "Unknown". */
export function fmtListed(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined || !currency) return 'Unknown'
  return `${currency} ${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
