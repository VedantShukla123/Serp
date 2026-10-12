/* Booking simulator helpers (no React) — unit-tested with `node --test`.
   Mirrors app/services/booking.py validation; the backend stays the authority. */

export const DISCLAIMER = 'SIMULATED BOOKING — NO REAL RESERVATION CREATED — NO PAYMENT CHARGED'
export const MAX_GUESTS = 10
export const MAX_NIGHTS = 30

export type BookingForm = { guest_name: string; email: string; guests: string; check_in: string; check_out: string }
export type FieldErrors = Partial<Record<keyof BookingForm, string>>

const ISO = /^\d{4}-\d{2}-\d{2}$/
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function days(iso: string): number | null {
  if (!ISO.test(iso)) return null
  const t = Date.parse(iso + 'T00:00:00Z')
  return Number.isNaN(t) ? null : Math.round(t / 86_400_000)
}

/** `today` is YYYY-MM-DD (local date) so tests are deterministic. */
export function validateBookingForm(f: BookingForm, today: string): FieldErrors {
  const e: FieldErrors = {}
  if (!f.guest_name.trim()) e.guest_name = 'Guest name is required.'
  else if (f.guest_name.trim().length > 100) e.guest_name = 'Guest name is too long.'
  if (!EMAIL.test(f.email.trim())) e.email = 'Enter a valid email address.'
  const g = Number(f.guests)
  if (!f.guests.trim() || !Number.isInteger(g) || g < 1 || g > MAX_GUESTS) e.guests = `Guests must be between 1 and ${MAX_GUESTS}.`
  const ci = days(f.check_in), co = days(f.check_out), now = days(today)
  if (ci === null) e.check_in = 'Check-in date is required.'
  else if (now !== null && ci < now) e.check_in = 'Check-in cannot be in the past.'
  if (co === null) e.check_out = 'Check-out date is required.'
  else if (ci !== null && co <= ci) e.check_out = 'Check-out must be after check-in.'
  else if (ci !== null && co - ci > MAX_NIGHTS) e.check_out = `Stays are limited to ${MAX_NIGHTS} nights.`
  return e
}

export function nightsBetween(checkIn: string, checkOut: string): number | null {
  const a = days(checkIn), b = days(checkOut)
  return a !== null && b !== null && b > a ? b - a : null
}

/** Normal-flow gate: REJECTED never; anything not VERIFIED needs the review acknowledgement. */
export function canSimulate(status: string, acknowledged: boolean): boolean {
  const s = status.toUpperCase()
  if (s === 'REJECTED') return false
  return s === 'VERIFIED' || acknowledged
}

export function fmtMoney(value: number | null | undefined, currency: string | null | undefined): string {
  if (value === null || value === undefined) return 'Unknown'
  const sym = currency === 'INR' ? '₹' : currency ? `${currency} ` : ''
  return `${sym}${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

export function localToday(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
