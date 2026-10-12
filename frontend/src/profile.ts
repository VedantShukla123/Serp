/* What the navbar profile menu shows (no React) — unit-tested. The user comes from the existing
   session state in api.ts (stored profile, refreshed by GET /v1/auth/me); nothing here is invented. */
import type { User } from './api.ts'

export type ProfileStatus = 'loading' | 'ready' | 'error'
export type ProfileView = { initial: string; name: string; email: string; note: string | null; busy: boolean }

/** First letter of the name, else of the email, else '?'. */
export function initialOf(user: Pick<User, 'name' | 'email'> | null): string {
  const s = (user?.name || user?.email || '').trim()
  return s ? s.charAt(0).toUpperCase() : '?'
}

/** A known profile is always shown (even if a refresh failed); otherwise a neutral loading or error state. */
export function profileView(user: User | null, status: ProfileStatus): ProfileView {
  if (user) {
    const name = user.name?.trim() || user.email
    return { initial: initialOf(user), name, email: user.email, note: null, busy: false }
  }
  if (status === 'loading') return { initial: '', name: 'Loading profile…', email: '', note: null, busy: true }
  return { initial: '?', name: 'Your account', email: '', note: 'Profile details couldn’t be loaded right now.', busy: false }
}
