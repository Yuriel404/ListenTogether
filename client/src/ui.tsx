import { useEffect, useRef, type ReactNode } from 'react'
import { AudioLines, Disc3, LoaderCircle, X } from 'lucide-react'

export function Brand({ onClick }: { onClick: () => void }) {
  return <button className="brand" onClick={onClick} aria-label="返回同频首页"><span className="brand-mark"><AudioLines size={24} /></span><span>同频<span className="brand-sub">LISTEN TOGETHER</span></span></button>
}

export function Spinner({ label = '加载中' }: { label?: string }) {
  return <span className="spinner-label" role="status"><LoaderCircle size={17} className="spin" />{label}</span>
}

export function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.querySelector<HTMLElement>('input, button, textarea')?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
      if (event.key !== 'Tab') return
      const focusable = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || [])]
      const first = focusable[0], last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', key); previous?.focus() }
  }, [])
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className={`dialog ${wide ? 'dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
      <div className="dialog-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭弹窗"><X size={21} /></button></div>
      {children}
    </div>
  </div>
}

const tones = ['#d8e8b7', '#e6d3b3', '#d7dfeb', '#e8c8bd', '#d7e3db']
export function Avatar({ name, index = 0, small = false }: { name: string; index?: number; small?: boolean }) {
  return <span className={`avatar ${small ? 'avatar-small' : ''}`} style={{ background: tones[index % tones.length] }} aria-label={name}>{Array.from(name)[0] || '友'}</span>
}

export function Artwork({ title, cover, id, className = '' }: { title: string; cover?: string; id?: string; className?: string }) {
  const index = (id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 4
  return <div className={`artwork artwork-${index} ${className}`}>
    {cover ? <img src={cover} alt={`${title}封面`} loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.style.opacity = '0' }} /> : <><div className="artwork-orbit" /><Disc3 size={26} className="artwork-disc" /><span className="artwork-title">{title}</span></>}
  </div>
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}
