import { useEffect, useState, type FormEvent } from 'react'
import {
  canSimulate, DISCLAIMER, fmtMoney, localToday, MAX_GUESTS, validateBookingForm,
  type BookingForm, type FieldErrors,
} from './booking'

/* Dynamic Booking Simulator — DEMO ONLY. Hotel, price and status come from the
   backend (stored run, by candidate_id); this component only sends guest details. */

type Req = { requirement_id: string; description: string; status: string }
type Context = {
  run_id: string
  candidate_id: string
  hotel: { name: string | null; address: string | null; rating: number | null; source_url: string | null; cancellation_info: string | null }
  price: {
    currency: string | null
    per_night: number | null; per_night_display: string | null
    listed_total: number | null; listed_total_display: string | null; listed_total_note: string | null
    listed_price_display: string | null
  }
  verification_status: string
  unresolved_requirements: Req[]
  contradicted_requirements: Req[]
  bookable: boolean
  requires_acknowledgement: boolean
}
type Preview = Context & {
  guest: { guest_name: string; email: string; guests: number; check_in: string; check_out: string; nights: number }
  estimated_total: number | null
  estimated_total_note: string | null
}
type Booking = Preview & { booking_id: string; status: string; created_at: string; acknowledged_unverified: boolean }
type ApiError = { code?: string; message?: string; errors?: Record<string, string> }

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) {
    const d = (j as { detail?: ApiError | string }).detail
    throw (typeof d === 'object' && d ? d : { message: typeof d === 'string' ? d : `HTTP ${res.status}` }) as ApiError
  }
  return j as T
}

function statusClass(s: string): string {
  const t = s.toUpperCase()
  return t === 'VERIFIED' ? 'ok' : t === 'REJECTED' ? 'bad' : 'warn'
}

function PriceBlock({ c, estimate }: { c: Context; estimate?: { value: number | null; note: string | null; nights: number } }) {
  const p = c.price
  return (
    <dl className="bk-prices">
      <dt>Listed rate per night</dt><dd>{p.per_night_display ?? fmtMoney(p.per_night, p.currency)}</dd>
      {p.listed_price_display && <><dt>Listed price (basis unknown)</dt><dd>{p.listed_price_display}</dd></>}
      <dt>Listed total</dt>
      <dd>{p.listed_total_display ?? fmtMoney(p.listed_total, p.currency)}{p.listed_total_note && <small>{p.listed_total_note}</small>}</dd>
      {estimate && <>
        <dt>Estimate for your {estimate.nights} night{estimate.nights === 1 ? '' : 's'}</dt>
        <dd>{fmtMoney(estimate.value, p.currency)}{estimate.note && <small>{estimate.note}</small>}</dd>
      </>}
      <dt>Cancellation terms</dt><dd>{c.hotel.cancellation_info || 'Unknown'}</dd>
    </dl>
  )
}

function OpenPoints({ c }: { c: Context }) {
  if (!c.unresolved_requirements.length && !c.contradicted_requirements.length) return null
  return (
    <ul className="flag-list">
      {[...c.contradicted_requirements, ...c.unresolved_requirements].map((r) => (
        <li key={r.requirement_id + r.status}><span className={`vpill ${r.status === 'CONTRADICTED' ? 'bad' : 'warn'}`}>{r.status}</span> {r.description}</li>
      ))}
    </ul>
  )
}

export default function BookingSimulator({ runId, candidateId, onClose }: { runId: string; candidateId: string; onClose: () => void }) {
  const [step, setStep] = useState<'loading' | 'form' | 'review' | 'done' | 'blocked'>('loading')
  const [ctx, setCtx] = useState<Context | null>(null)
  const [form, setForm] = useState<BookingForm>({ guest_name: '', email: '', guests: '2', check_in: '', check_out: '' })
  const [errors, setErrors] = useState<FieldErrors>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [ack, setAck] = useState(false)
  const [booking, setBooking] = useState<Booking | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api<Context>(`/v1/runs/${encodeURIComponent(runId)}/candidates/${encodeURIComponent(candidateId)}/booking-context`)
      .then((c) => { setCtx(c); setStep(c.bookable ? 'form' : 'blocked') })
      .catch((e: ApiError) => { setErr(e.message || 'Could not load this hotel.'); setStep('blocked') })
  }, [runId, candidateId])

  const today = localToday()
  const body = () => ({ run_id: runId, candidate_id: candidateId, ...form, guests: Number(form.guests) || null, acknowledge_unverified: ack })

  async function toReview(ev: FormEvent) {
    ev.preventDefault()
    const e = validateBookingForm(form, today)
    setErrors(e); setErr(null)
    if (Object.keys(e).length) return
    setBusy(true)
    try { setPreview(await api<Preview>('/v1/bookings/preview', body())); setAck(false); setStep('review') }
    catch (x) { const a = x as ApiError; setErrors((a.errors ?? {}) as FieldErrors); setErr(a.message || 'Preview failed.') }
    finally { setBusy(false) }
  }

  async function approve() {
    setBusy(true); setErr(null)
    try { setBooking(await api<Booking>('/v1/bookings', body())); setStep('done') }
    catch (x) { setErr((x as ApiError).message || 'Simulation failed.') }
    finally { setBusy(false) }
  }

  const field = (k: keyof BookingForm, label: string, type = 'text', extra: Record<string, string | number> = {}) => (
    <label className={'bk-field' + (errors[k] ? ' invalid' : '')}>
      <span>{label}</span>
      <input type={type} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} {...extra} />
      {errors[k] && <em>{errors[k]}</em>}
    </label>
  )

  return (
    <div className="bk-overlay" role="dialog" aria-modal="true" aria-label="Booking simulator" onClick={onClose}>
      <div className="bk-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bk-banner">{DISCLAIMER}</div>
        <button className="bk-close" onClick={onClose} aria-label="Close">×</button>

        {step === 'loading' && <p className="bk-pad"><span className="spinner" />Loading hotel from the stored run…</p>}

        {step === 'blocked' && (
          <div className="bk-pad">
            <h3>Booking not available</h3>
            {ctx && !ctx.bookable ? (
              <>
                <p><b>{ctx.hotel.name ?? ctx.candidate_id}</b> was <span className="vpill bad">REJECTED</span> by Jev — a required point was contradicted, so it cannot be booked.</p>
                <OpenPoints c={{ ...ctx, unresolved_requirements: [] }} />
              </>
            ) : <p className="err-text">{err}</p>}
            <div className="bk-actions"><button className="bk-btn ghost" onClick={onClose}>Close</button></div>
          </div>
        )}

        {ctx && (step === 'form' || step === 'review') && (
          <div className="bk-hotel">
            <div className="final-name">{ctx.hotel.name ?? 'Unknown hotel'}</div>
            <div className="final-meta">
              <span className={`vpill ${statusClass(ctx.verification_status)}`}>{ctx.verification_status.replace('_', ' ')}</span>
              <span className="run-id">candidate {ctx.candidate_id} · run {ctx.run_id}</span>
              {ctx.hotel.source_url && <a href={ctx.hotel.source_url} target="_blank" rel="noreferrer">view source ↗</a>}
            </div>
          </div>
        )}

        {ctx && step === 'form' && (
          <form className="bk-pad" onSubmit={toReview} noValidate>
            <PriceBlock c={ctx} />
            <div className="bk-grid">
              {field('guest_name', 'Guest name', 'text', { autoComplete: 'name', maxLength: 100 })}
              {field('email', 'Email', 'email', { autoComplete: 'email' })}
              {field('guests', 'Guests', 'number', { min: 1, max: MAX_GUESTS })}
              <span />
              {field('check_in', 'Check-in', 'date', { min: today })}
              {field('check_out', 'Check-out', 'date', { min: form.check_in || today })}
            </div>
            <p className="bk-note">No payment details are collected. This creates a demo record only.</p>
            {err && <p className="err-text">{err}</p>}
            <div className="bk-actions">
              <button type="button" className="bk-btn ghost" onClick={onClose}>Cancel</button>
              <button type="submit" className="bk-btn" disabled={busy}>{busy ? 'Checking…' : 'Review booking →'}</button>
            </div>
          </form>
        )}

        {preview && step === 'review' && (
          <div className="bk-pad">
            <h3>Review simulated booking</h3>
            <dl className="bk-prices">
              <dt>Guest</dt><dd>{preview.guest.guest_name} · {preview.guest.email}</dd>
              <dt>Guests</dt><dd>{preview.guest.guests}</dd>
              <dt>Dates</dt><dd>{preview.guest.check_in} → {preview.guest.check_out} ({preview.guest.nights} night{preview.guest.nights === 1 ? '' : 's'})</dd>
            </dl>
            <PriceBlock c={preview} estimate={{ value: preview.estimated_total, note: preview.estimated_total_note, nights: preview.guest.nights }} />
            {preview.requires_acknowledgement && (
              <div className="final warn bk-ack">
                <span className="final-badge warn">◷ NEEDS HUMAN REVIEW</span>
                <p className="flag-intro">This hotel is <b>not verified</b>. Open points:</p>
                <OpenPoints c={preview} />
                <label className="bk-check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  I reviewed these unverified points and want to simulate anyway.
                </label>
              </div>
            )}
            {err && <p className="err-text">{err}</p>}
            <div className="bk-actions">
              <button className="bk-btn ghost" onClick={() => setStep('form')}>← Edit</button>
              <button className="bk-btn" onClick={approve}
                disabled={busy || !canSimulate(preview.verification_status, ack)}>
                {busy ? 'Simulating…' : 'Approve simulation'}
              </button>
            </div>
          </div>
        )}

        {booking && step === 'done' && (
          <div className="bk-pad bk-done">
            <span className="final-badge">✓ SIMULATION CONFIRMED</span>
            <div className="bk-id">{booking.booking_id}</div>
            <div className="final-name">{booking.hotel.name ?? booking.candidate_id}</div>
            <dl className="bk-prices">
              <dt>Guest</dt><dd>{booking.guest.guest_name} · {booking.guest.guests} guest{booking.guest.guests === 1 ? '' : 's'}</dd>
              <dt>Dates</dt><dd>{booking.guest.check_in} → {booking.guest.check_out} ({booking.guest.nights} night{booking.guest.nights === 1 ? '' : 's'})</dd>
              <dt>Listed rate per night</dt><dd>{booking.price.per_night_display ?? fmtMoney(booking.price.per_night, booking.price.currency)}</dd>
              <dt>Estimate for your stay</dt><dd>{fmtMoney(booking.estimated_total, booking.price.currency)}{booking.estimated_total_note && <small>{booking.estimated_total_note}</small>}</dd>
              <dt>Jev status</dt><dd><span className={`vpill ${statusClass(booking.verification_status)}`}>{booking.verification_status.replace('_', ' ')}</span>{booking.acknowledged_unverified && <small>Simulated after human-review acknowledgement.</small>}</dd>
            </dl>
            <p className="bk-note"><b>{DISCLAIMER}.</b> Nothing was sent to the hotel or any booking site.</p>
            <div className="run-id">candidate {booking.candidate_id} · run {booking.run_id} · {booking.created_at}</div>
            <div className="bk-actions"><button className="bk-btn" onClick={onClose}>Done</button></div>
          </div>
        )}
      </div>
    </div>
  )
}
