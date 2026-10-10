/* Minimal hash router: #/, #/signin, #/app/playground … (no dependency). */
export type Route =
  | { page: 'landing' } | { page: 'signin' } | { page: 'signup' } | { page: 'forgot' }
  | { page: 'app'; tab: 'assistant' | 'playground' | 'developers'; sub: string | null; arg: string | null }

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  const [a, b, c, d] = parts
  if (a === 'signin' || a === 'signup' || a === 'forgot') return { page: a }
  if (a === 'app') {
    const tab = b === 'playground' || b === 'developers' ? b : 'assistant'
    const dev = tab === 'developers'
    return { page: 'app', tab, sub: dev ? c ?? null : null, arg: dev && d ? decodeURIComponent(d) : null }
  }
  return { page: 'landing' }
}

export function go(path: string) {
  window.location.hash = path.startsWith('#') ? path : `#${path}`
}
