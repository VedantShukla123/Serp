/* Minimal hash router: #/, #/signin, #/app/playground … (no dependency). */
export type Route =
  | { page: 'landing' } | { page: 'signin' } | { page: 'signup' } | { page: 'forgot' }
  | { page: 'app'; tab: 'assistant' | 'playground' | 'developers'; sub: string | null }

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const [a, b, c] = parts
  if (a === 'signin' || a === 'signup' || a === 'forgot') return { page: a }
  if (a === 'app') {
    const tab = b === 'playground' || b === 'developers' ? b : 'assistant'
    return { page: 'app', tab, sub: tab === 'developers' ? c ?? null : null }
  }
  return { page: 'landing' }
}

export function go(path: string) {
  window.location.hash = path.startsWith('#') ? path : `#${path}`
}
