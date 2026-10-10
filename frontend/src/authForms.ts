/* Demo-access form validation (no React). There is NO authentication backend in this
   build: these validators only drive UI feedback; credentials are never sent or stored. */

export type AuthErrors = Partial<Record<'name' | 'email' | 'password' | 'confirm' | 'terms', string>>
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export function validateSignIn(f: { email: string; password: string }): AuthErrors {
  const e: AuthErrors = {}
  if (!EMAIL.test(f.email.trim())) e.email = 'Enter a valid email address.'
  if (!f.password) e.password = 'Enter your password.'
  return e
}

export function validateSignUp(f: { name: string; email: string; password: string; confirm: string; terms: boolean }): AuthErrors {
  const e: AuthErrors = {}
  if (!f.name.trim()) e.name = 'Enter your name.'
  if (!EMAIL.test(f.email.trim())) e.email = 'Enter a valid email address.'
  if (f.password.length < 8) e.password = 'Use at least 8 characters.'
  else if (!/[A-Za-z]/.test(f.password) || !/\d/.test(f.password)) e.password = 'Use letters and at least one number.'
  if (f.confirm !== f.password) e.confirm = 'Passwords do not match.'
  if (!f.terms) e.terms = 'Acknowledge that this is a demo workspace.'
  return e
}

export function validateForgot(f: { email: string }): AuthErrors {
  return EMAIL.test(f.email.trim()) ? {} : { email: 'Enter a valid email address.' }
}
