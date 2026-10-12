/* Sign-in / sign-up form validation (no React) — unit-tested. These checks only give instant
   feedback; the server validates everything again (app/api/auth_routes.py) and its limits are
   mirrored here so both sides agree. */

export type AuthErrors = Partial<Record<'name' | 'email' | 'password' | 'confirm', string>>
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export const PASSWORD_MIN = 10
export const PASSWORD_MAX = 128
export const NAME_MAX = 100
export const EMAIL_MAX = 254

export function validateSignIn(f: { email: string; password: string }): AuthErrors {
  const e: AuthErrors = {}
  const email = f.email.trim()
  if (!EMAIL.test(email) || email.length > EMAIL_MAX) e.email = 'Enter a valid email address.'
  if (!f.password) e.password = 'Enter your password.'
  else if (f.password.length > PASSWORD_MAX) e.password = 'That password is too long.'
  return e
}

export function validateSignUp(f: { name: string; email: string; password: string; confirm: string }): AuthErrors {
  const e: AuthErrors = {}
  const name = f.name.trim()
  const email = f.email.trim()
  if (!name) e.name = 'Enter your name.'
  else if (name.length > NAME_MAX) e.name = `Use at most ${NAME_MAX} characters.`
  if (!EMAIL.test(email) || email.length > EMAIL_MAX) e.email = 'Enter a valid email address.'
  if (f.password.length < PASSWORD_MIN) e.password = `Use at least ${PASSWORD_MIN} characters.`
  else if (f.password.length > PASSWORD_MAX) e.password = `Use at most ${PASSWORD_MAX} characters.`
  else if (!f.password.trim()) e.password = 'The password cannot be only spaces.'
  if (!f.confirm) e.confirm = 'Confirm your password.'
  else if (f.confirm !== f.password) e.confirm = 'Passwords do not match.'
  return e
}
