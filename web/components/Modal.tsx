'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export default function Modal({ onClose, children, footer, narrow, label }: {
  onClose: () => void; children: ReactNode; footer?: ReactNode; narrow?: boolean; label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog${narrow ? ' narrow' : ''}`} role="dialog" aria-modal="true" aria-label={label} ref={ref} tabIndex={-1}>
        <div className="grip" aria-hidden="true" />
        <button type="button" className="close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}
