'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'

export function Modal({ title, kicker, onClose, children, wide, bodyClassName }: {
  title: string
  kicker: string
  onClose: () => void
  children: React.ReactNode
  wide?: boolean
  bodyClassName?: string
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal-window ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="panel-kicker">{kicker}</div>
            <h2>{title}</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X /></button>
        </div>
        <div className={`modal-body ${bodyClassName ?? ''}`}>{children}</div>
      </div>
    </div>
  )
}
