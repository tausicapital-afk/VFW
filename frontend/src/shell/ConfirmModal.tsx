import { useEffect, useRef, useState } from 'react';

/**
 * The shared confirm dialog. Replaces window.confirm/window.prompt — native
 * dialogs block the page's event loop, can't be styled, and are invisible to
 * anything driving the browser (tests, automation). Covers both shapes used
 * across the app:
 *
 *     {open && (
 *       <ConfirmModal
 *         title="Remove the unpaid instalments?"
 *         message="Paid ones are kept."
 *         danger
 *         onCancel={() => setOpen(false)}
 *         onConfirm={() => { setOpen(false); doIt(); }}
 *       />
 *     )}
 *
 * Pass reasonLabel to add a free-text field — onConfirm then receives its
 * value. Mirrors window.prompt's semantics: Cancel/Escape never calls
 * onConfirm, an empty reason is a confirmed action with nothing typed.
 */
export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  reasonLabel,
  reasonPlaceholder,
  pending,
  onCancel,
  onConfirm,
}: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (reason?: string) => void;
}) {
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  useEffect(() => {
    if (reasonLabel) reasonRef.current?.focus();
  }, [reasonLabel]);

  return (
    <div className="modal" onClick={onCancel}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>{title}</h3>
        </div>
        <div className="bd">
          {message && <p className="sm">{message}</p>}
          {reasonLabel && (
            <div className="f" style={{ marginTop: message ? 12 : 0 }}>
              <label>{reasonLabel}</label>
              <input
                ref={reasonRef}
                value={reason}
                placeholder={reasonPlaceholder}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onConfirm(reason); }}
              />
            </div>
          )}
        </div>
        <div className="ft">
          <button className="btn" disabled={pending} onClick={onCancel}>{cancelLabel}</button>
          <button
            className={'btn' + (danger ? ' dgr' : ' primary')}
            disabled={pending}
            onClick={() => onConfirm(reason)}
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
