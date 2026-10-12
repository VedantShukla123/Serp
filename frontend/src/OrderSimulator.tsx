import { useState, type FormEvent } from 'react'
import { canSimulate } from './booking'
import { apiFetch } from './api'
import { fmtListed, MAX_QUANTITY, ORDER_DISCLAIMER, validateOrderForm, type OrderErrors, type OrderForm } from './actionTypes'

/* Simulated PRODUCT ORDER — demo only. Product, listed price and Jev status come from the
   backend (stored run, by candidate_id); this component only sends buyer details.
   No payment fields, nothing sent to the seller, prices never converted. */

type Req = { requirement_id: string; description: string; status: string }
export type OrderContext = {
  run_id: string; candidate_id: string; target_type: 'product'
  product: { title: string | null; seller: string | null; rating: number | null; review_count: number | null; source_url: string | null; delivery_info: string | null }
  price: { listed_display: string | null; value: number | null; currency: string | null; currency_source: string | null; currency_reliable: boolean; note: string | null }
  verification_status: string
  unresolved_requirements: Req[]; contradicted_requirements: Req[]
  orderable: boolean; requires_acknowledgement: boolean
}
type Preview = OrderContext & { buyer: { buyer_name: string; email: string; quantity: number; delivery_address: string }; subtotal: number | null; subtotal_note: string }
type Order = Preview & { order_id: string; status: string; created_at: string; acknowledged_unverified: boolean }
type ApiError = { code?: string; message?: string; errors?: Record<string, string> }

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    const d = (j as { detail?: ApiError | string }).detail
    throw (typeof d === 'object' && d ? d : { message: typeof d === 'string' ? d : `HTTP ${res.status}` }) as ApiError
  }
  return j as T
}

const pill = (s: string) => (s === 'VERIFIED' ? 'ok' : s === 'REJECTED' ? 'bad' : 'warn')

function PriceRows({ c }: { c: OrderContext }) {
  const p = c.price
  return (
    <>
      <dt>Listed price</dt>
      <dd>{p.listed_display ?? 'Unknown'}{p.currency && <small>Currency {p.currency}{p.currency_source === 'symbol' ? ' (from the listed symbol)' : ''} · not converted</small>}{p.note && <small>{p.note}</small>}</dd>
      <dt>Seller</dt><dd>{c.product.seller ?? 'Unknown'}</dd>
      <dt>Delivery</dt><dd>{c.product.delivery_info ? <>{c.product.delivery_info}<small>As listed by the search — not a delivery promise.</small></> : 'Unknown'}</dd>
    </>
  )
}

function OpenPoints({ c }: { c: OrderContext }) {
  const rows = [...c.contradicted_requirements, ...c.unresolved_requirements]
  if (!rows.length) return null
  return (
    <ul className="flag-list">
      {rows.map((r) => <li key={r.requirement_id + r.status}><span className={`vpill ${r.status === 'CONTRADICTED' ? 'bad' : 'warn'}`}>{r.status}</span> {r.description}</li>)}
    </ul>
  )
}

export default function OrderSimulator({ ctx, onClose }: { ctx: OrderContext; onClose: () => void }) {
  const [step, setStep] = useState<'form' | 'review' | 'done'>('form')
  const [form, setForm] = useState<OrderForm>({ buyer_name: '', email: '', quantity: '1', delivery_address: '' })
  const [errors, setErrors] = useState<OrderErrors>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [ack, setAck] = useState(false)
  const [order, setOrder] = useState<Order | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const body = () => ({ run_id: ctx.run_id, candidate_id: ctx.candidate_id, ...form, quantity: Number(form.quantity) || null, acknowledge_unverified: ack })

  async function toReview(ev: FormEvent) {
    ev.preventDefault()
    const e = validateOrderForm(form)
    setErrors(e); setErr(null)
    if (Object.keys(e).length) return
    setBusy(true)
    try { setPreview(await post<Preview>('/v1/orders/preview', body())); setAck(false); setStep('review') }
    catch (x) { const a = x as ApiError; setErrors((a.errors ?? {}) as OrderErrors); setErr(a.message || 'Preview failed.') }
    finally { setBusy(false) }
  }

  async function approve() {
    setBusy(true); setErr(null)
    try { setOrder(await post<Order>('/v1/orders', body())); setStep('done') }
    catch (x) { setErr((x as ApiError).message || 'Simulation failed.') }
    finally { setBusy(false) }
  }

  const field = (k: keyof OrderForm, label: string, type = 'text', extra: Record<string, string | number> = {}) => (
    <label className={'bk-field' + (errors[k] ? ' invalid' : '')}>
      <span>{label}</span>
      {k === 'delivery_address'
        ? <textarea value={form[k]} rows={2} onChange={(e) => setForm({ ...form, [k]: e.target.value })} maxLength={300} />
        : <input type={type} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} {...extra} />}
      {errors[k] && <em>{errors[k]}</em>}
    </label>
  )

  return (
    <div className="bk-overlay" role="dialog" aria-modal="true" aria-label="Order simulator" onClick={onClose}>
      <div className="bk-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bk-banner">{ORDER_DISCLAIMER}</div>
        <button className="bk-close" onClick={onClose} aria-label="Close">×</button>

        {!ctx.orderable && (
          <div className="bk-pad">
            <h3>Order not available</h3>
            <p><b>{ctx.product.title ?? ctx.candidate_id}</b> was <span className="vpill bad">REJECTED</span> by Jev — a required point was contradicted, so it cannot be ordered.</p>
            <OpenPoints c={{ ...ctx, unresolved_requirements: [] }} />
            <div className="bk-actions"><button className="bk-btn ghost" onClick={onClose}>Close</button></div>
          </div>
        )}

        {ctx.orderable && step !== 'done' && (
          <div className="bk-hotel">
            <span className="kind-tag">Product order</span>
            <div className="final-name">{ctx.product.title ?? 'Unknown product'}</div>
            <div className="final-meta">
              <span className={`vpill ${pill(ctx.verification_status)}`}>{ctx.verification_status.replace('_', ' ')}</span>
              <span className="run-id">candidate {ctx.candidate_id} · run {ctx.run_id}</span>
              {ctx.product.source_url && <a href={ctx.product.source_url} target="_blank" rel="noreferrer">view listing ↗</a>}
            </div>
          </div>
        )}

        {ctx.orderable && step === 'form' && (
          <form className="bk-pad" onSubmit={toReview} noValidate>
            <dl className="bk-prices"><PriceRows c={ctx} /></dl>
            <div className="bk-grid">
              {field('buyer_name', 'Buyer name', 'text', { autoComplete: 'name', maxLength: 100 })}
              {field('email', 'Email', 'email', { autoComplete: 'email' })}
              {field('quantity', 'Quantity', 'number', { min: 1, max: MAX_QUANTITY })}
              <span />
            </div>
            <div className="bk-grid one">{field('delivery_address', 'Delivery details (demo only — never sent anywhere)')}</div>
            <p className="bk-note">No payment details are collected and nothing is sent to the seller. This creates a demo record only.</p>
            {err && <p className="err-text">{err}</p>}
            <div className="bk-actions">
              <button type="button" className="bk-btn ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="bk-btn" disabled={busy}>{busy ? 'Checking…' : 'Review order →'}</button>
            </div>
          </form>
        )}

        {preview && step === 'review' && (
          <div className="bk-pad">
            <h3>Review simulated order</h3>
            <dl className="bk-prices">
              <dt>Buyer</dt><dd>{preview.buyer.buyer_name} · {preview.buyer.email}</dd>
              <dt>Deliver to</dt><dd>{preview.buyer.delivery_address}</dd>
              <dt>Quantity</dt><dd>{preview.buyer.quantity}</dd>
              <PriceRows c={preview} />
              <dt>Subtotal</dt><dd>{preview.subtotal !== null ? fmtListed(preview.subtotal, preview.price.currency) : 'Not calculated'}<small>{preview.subtotal_note}</small></dd>
            </dl>
            {preview.requires_acknowledgement && (
              <div className="final warn bk-ack">
                <span className="final-badge warn">◷ NEEDS HUMAN REVIEW</span>
                <p className="flag-intro">This product is <b>not verified</b>. Open points:</p>
                <OpenPoints c={preview} />
                <label className="bk-check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  I reviewed these unverified points and want to simulate the order anyway.
                </label>
              </div>
            )}
            {err && <p className="err-text">{err}</p>}
            <div className="bk-actions">
              <button className="bk-btn ghost" onClick={() => setStep('form')}>← Edit</button>
              <button className="bk-btn" onClick={approve} disabled={busy || !canSimulate(preview.verification_status, ack)}>
                {busy ? 'Simulating…' : 'Approve simulated order'}
              </button>
            </div>
          </div>
        )}

        {order && step === 'done' && (
          <div className="bk-pad bk-done">
            <span className="final-badge">✓ SIMULATED ORDER CONFIRMED</span>
            <div className="bk-id">{order.order_id}</div>
            <div className="final-name">{order.product.title ?? order.candidate_id}</div>
            <dl className="bk-prices">
              <dt>Buyer</dt><dd>{order.buyer.buyer_name} · quantity {order.buyer.quantity}</dd>
              <dt>Listed price</dt><dd>{order.price.listed_display ?? 'Unknown'}</dd>
              <dt>Subtotal</dt><dd>{order.subtotal !== null ? fmtListed(order.subtotal, order.price.currency) : 'Not calculated'}</dd>
              <dt>Jev status</dt><dd><span className={`vpill ${pill(order.verification_status)}`}>{order.verification_status.replace('_', ' ')}</span>{order.acknowledged_unverified && <small>Simulated after human-review acknowledgement.</small>}</dd>
            </dl>
            <p className="bk-note"><b>{ORDER_DISCLAIMER}.</b> Nothing was purchased and nothing was sent to {order.product.seller ?? 'the seller'}.</p>
            <div className="run-id">candidate {order.candidate_id} · run {order.run_id} · {order.created_at}</div>
            <div className="bk-actions"><button className="bk-btn" onClick={onClose}>Done</button></div>
          </div>
        )}
      </div>
    </div>
  )
}
