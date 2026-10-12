import { useEffect, useId, useRef, useState } from 'react'
import type { User } from './api'
import { profileView, type ProfileStatus } from './profile'

/* Navbar profile button + dropdown (disclosure pattern). Shows the signed-in account from the
   existing session state; Sign out calls the caller's existing logout flow. */

export default function ProfileMenu({ user, status, onSignOut }: { user: User | null; status: ProfileStatus; onSignOut: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const signOutBtn = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const v = profileView(user, status)

  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus() } }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [open])

  function toggle(fromKeyboard: boolean) {
    const next = !open
    setOpen(next)
    // Keyboard users land on the menu's action; mouse users keep focus where they clicked.
    if (next && fromKeyboard) requestAnimationFrame(() => signOutBtn.current?.focus())
  }

  async function signOut() {
    if (leaving) return
    setLeaving(true)
    try { await onSignOut() } finally { setLeaving(false); setOpen(false) }
  }

  return (
    <div className="profile" ref={wrap}
      onBlur={(e) => { if (open && !wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false) }}>
      <button ref={trigger} type="button" className={'profile-btn' + (open ? ' open' : '')}
        aria-expanded={open} aria-controls={panelId}
        aria-label={v.busy ? 'Account menu, loading profile' : `Account menu for ${v.name}`}
        onClick={(e) => toggle(e.detail === 0)}>
        <span className={'pf-avatar' + (v.busy ? ' busy' : '')} aria-hidden>{v.busy ? <span className="spinner xs" /> : v.initial}</span>
        <span className="profile-name">{v.busy ? 'Loading…' : v.name}</span>
        <svg className="profile-caret" viewBox="0 0 12 12" aria-hidden><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>

      <div id={panelId} className={'profile-panel' + (open ? ' open' : '')} role="region" aria-label="Account">
        <div className="profile-id">
          <span className={'pf-avatar lg' + (v.busy ? ' busy' : '')} aria-hidden>{v.busy ? <span className="spinner xs" /> : v.initial}</span>
          <span className="profile-text">
            <b>{v.name}</b>
            {v.email && <span className="profile-email">{v.email}</span>}
            {v.note && <span className="profile-note" role="status">{v.note}</span>}
          </span>
        </div>
        <hr />
        <button ref={signOutBtn} type="button" className="profile-signout" onClick={signOut} disabled={leaving} tabIndex={open ? 0 : -1}>
          <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 17l5-5-5-5M21 12H9" />
          </svg>
          {leaving ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </div>
  )
}
