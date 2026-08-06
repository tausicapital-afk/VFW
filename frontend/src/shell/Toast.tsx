import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * The global success/failure popup. One provider at the root of the app; any
 * screen calls useToast() and gets a toast in the top-right corner, above the
 * modal layer — most of what needs confirming is confirmed from inside a modal.
 */

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  /** The line the user reads. Required — a toast with no message says nothing. */
  message: string;
  /** Defaults to the type's own heading ("Saved", "Something went wrong", …). */
  title?: string;
  /** Defaults to 'info'. */
  type?: ToastType;
  /** Milliseconds on screen before it dismisses itself. */
  duration?: number;
  /** Set false to drop the × and force the toast to time out. */
  closable?: boolean;
  /** One optional follow-up — "Undo", "View", "Retry". Dismisses on click. */
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends Required<Omit<ToastOptions, 'action'>> {
  id: string;
  action?: ToastOptions['action'];
}

interface ToastValue {
  toasts: ToastItem[];
  /** The general form. Returns the id, so a caller can dismiss it early. */
  showToast: (options: ToastOptions) => string;
  showSuccess: (message: string, title?: string, duration?: number) => string;
  showError: (message: string, title?: string, duration?: number) => string;
  showWarning: (message: string, title?: string, duration?: number) => string;
  showInfo: (message: string, title?: string, duration?: number) => string;
  hideToast: (id: string) => void;
  hideAll: () => void;
}

const DEFAULT_DURATION = 5000;
/** Errors are read, not glanced at, so they stay put roughly twice as long. */
const ERROR_DURATION = 9000;
const MAX_TOASTS = 5;
/** Must match the .toast-card transition in additions.css. */
const EXIT_MS = 220;

const TITLES: Record<ToastType, string> = {
  success: 'Done',
  error: 'Something went wrong',
  warning: 'Check this',
  info: 'Heads up',
};

/* The design system's icons are unicode glyphs (⚙ ◈ → ↓), so these are too. */
const GLYPHS: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  warning: '!',
  info: 'i',
};

const Ctx = createContext<ToastValue | null>(null);

let seq = 0;

function ToastCard({ toast, onClose }: { toast: ToastItem; onClose: (id: string) => void }) {
  const [shown, setShown] = useState(false);
  const [exiting, setExiting] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const closing = useRef(false);

  const close = useCallback(() => {
    // The × and the auto-dismiss timer race on the last toast; only one wins.
    if (closing.current) return;
    closing.current = true;
    setExiting(true);
    setTimeout(() => onClose(toast.id), EXIT_MS);
  }, [toast.id, onClose]);

  // Slide in on the frame after mount — from the same position, there is
  // nothing to transition from.
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 10);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!shown) return;

    // Drain the progress bar over exactly the toast's lifetime.
    if (bar.current) {
      bar.current.style.transition = `width ${toast.duration}ms linear`;
      bar.current.style.width = '0%';
    }

    const t = setTimeout(close, toast.duration);
    return () => clearTimeout(t);
  }, [shown, toast.duration, close]);

  return (
    <div
      className={`toast-card ${toast.type}${shown && !exiting ? ' in' : ''}`}
      role={toast.type === 'error' ? 'alert' : 'status'}
    >
      <span className="toast-ic" aria-hidden="true">{GLYPHS[toast.type]}</span>

      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        <div className="toast-msg">{toast.message}</div>
        {toast.action && (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              toast.action?.onClick();
              close();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>

      {toast.closable && (
        <button type="button" className="toast-x" onClick={close} aria-label="Dismiss">
          ✕
        </button>
      )}

      <div className="toast-bar">
        <div ref={bar} className="toast-bar-fill" style={{ transition: 'none' }} />
      </div>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const hideToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const hideAll = useCallback(() => setToasts([]), []);

  const showToast = useCallback((options: ToastOptions): string => {
    const type = options.type ?? 'info';
    const id = `toast-${++seq}`;

    const toast: ToastItem = {
      id,
      type,
      message: options.message,
      title: options.title ?? TITLES[type],
      duration: options.duration ?? (type === 'error' ? ERROR_DURATION : DEFAULT_DURATION),
      closable: options.closable !== false,
      action: options.action,
    };

    // Keep the newest few. A backlog of stale toasts is noise, not history.
    setToasts((prev) => [...prev, toast].slice(-MAX_TOASTS));
    return id;
  }, []);

  const showSuccess = useCallback(
    (message: string, title?: string, duration?: number) =>
      showToast({ message, title, duration, type: 'success' }),
    [showToast],
  );
  const showError = useCallback(
    (message: string, title?: string, duration?: number) =>
      showToast({ message, title, duration, type: 'error' }),
    [showToast],
  );
  const showWarning = useCallback(
    (message: string, title?: string, duration?: number) =>
      showToast({ message, title, duration, type: 'warning' }),
    [showToast],
  );
  const showInfo = useCallback(
    (message: string, title?: string, duration?: number) =>
      showToast({ message, title, duration, type: 'info' }),
    [showToast],
  );

  return (
    <Ctx.Provider
      value={{ toasts, showToast, showSuccess, showError, showWarning, showInfo, hideToast, hideAll }}
    >
      {children}
      {createPortal(
        <div className="toasts" aria-live="polite" aria-label="Notifications">
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} onClose={hideToast} />
          ))}
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  );
}

export function useToast(): ToastValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used inside <ToastProvider>');
  return v;
}
