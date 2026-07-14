import { useEffect, useRef, useState } from 'react';
import {
  downloadExport,
  EXPORT_FORMATS,
  FORMAT_LABEL,
  type ExportFormat,
} from '../lib/export';

/**
 * The system-wide export control. Drop it into any card header:
 *
 *     <ExportMenu dataset="submissions" />
 *
 * The dataset key is the server's (backend/src/export/export.registry.ts) — the
 * server decides which columns and which rows the file contains, so this button
 * can never export more than the caller may already see, and every screen's
 * export looks and behaves the same.
 */
export function ExportMenu({ dataset, disabled }: { dataset: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click-away or Escape, exactly as the user menu does.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    try {
      await downloadExport(dataset, format);
      setOpen(false);
    } catch (e) {
      // Keep the menu open on failure — closing it would hide the reason.
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="exportmenu" ref={ref}>
      <button
        className="btn sm"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || busy !== null}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ic">↓</span>
        {busy ? 'Exporting…' : 'Export'}
        <span className="chev">▾</span>
      </button>

      {open && (
        <div className="exportmenu-pop" role="menu">
          <div className="exportmenu-head">Download as</div>
          {EXPORT_FORMATS.map((format) => {
            const { label, hint, ic } = FORMAT_LABEL[format];
            return (
              <button
                key={format}
                className="exportmenu-item"
                role="menuitem"
                disabled={busy !== null}
                onClick={() => void run(format)}
              >
                <span className="ic">{ic}</span>
                <span className="t">
                  <span className="lb">{label}</span>
                  <span className="hint">{hint}</span>
                </span>
                {busy === format && <span className="sm mut">…</span>}
              </button>
            );
          })}
          {error && <div className="exportmenu-err">{error}</div>}
        </div>
      )}
    </div>
  );
}
