import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { AuthShell } from './Signup';

const LEN = 6;
const RESEND_COOLDOWN_S = 30;

/**
 * The step between signup and the dashboard: enter the six-digit code from the
 * welcome email. A correct code activates the account and returns a session, so
 * verifyOtp() lands the user straight in — App swaps the tree the moment ['me']
 * is populated, exactly like a login. There is no separate sign-in.
 */
export function VerifyOtp() {
  const { user, verifyOtp } = useAuth();
  const [params] = useSearchParams();
  const location = useLocation();
  // Signup forwards the address (and, in DEV_ECHO mode, the code itself).
  const state = (location.state ?? {}) as { email?: string; devOtp?: string };
  const email = (state.email ?? params.get('email') ?? '').trim().toLowerCase();
  const devOtp = state.devOtp;

  const [digits, setDigits] = useState<string[]>(() => Array(LEN).fill(''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  const code = useMemo(() => digits.join(''), [digits]);
  const complete = code.length === LEN;

  // Prefill the code when the dev echo handed it to us, so the flow is testable
  // without a mail account. Never happens in production.
  useEffect(() => {
    if (devOtp && /^\d{6}$/.test(devOtp)) setDigits(devOtp.split(''));
  }, [devOtp]);

  useEffect(() => {
    boxes.current[0]?.focus();
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Arriving here without an email means the signup step was skipped — send them
  // back to sign in rather than presenting a form that cannot possibly succeed.
  if (!email) return <Navigate to="/" replace />;
  // Already signed in (e.g. the code auto-submitted): App will take it from here.
  if (user) return <Navigate to="/" replace />;

  function setDigit(i: number, v: string) {
    setError(null);
    setDigits((prev) => {
      const next = [...prev];
      next[i] = v;
      return next;
    });
  }

  function onChange(i: number, raw: string) {
    const v = raw.replace(/\D/g, '');
    if (!v) {
      setDigit(i, '');
      return;
    }
    // Typing into a box: take the last digit entered and advance.
    setDigit(i, v[v.length - 1]);
    if (i < LEN - 1) boxes.current[i + 1]?.focus();
  }

  function onKeyDown(i: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      boxes.current[i - 1]?.focus();
      setDigit(i - 1, '');
    }
    if (e.key === 'ArrowLeft' && i > 0) boxes.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < LEN - 1) boxes.current[i + 1]?.focus();
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, LEN);
    if (!text) return;
    e.preventDefault();
    setError(null);
    const next = Array(LEN).fill('');
    for (let k = 0; k < text.length; k++) next[k] = text[k];
    setDigits(next);
    boxes.current[Math.min(text.length, LEN - 1)]?.focus();
  }

  async function submit(value: string) {
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(email, value);
      // No navigate(): once the session lands, App swaps the whole tree and the
      // /verify route falls through to the dashboard.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code could not be verified');
      setDigits(Array(LEN).fill(''));
      boxes.current[0]?.focus();
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!complete) return setError('Enter all 6 digits');
    void submit(code);
  }

  async function resend() {
    setResendMsg(null);
    setError(null);
    setCooldown(RESEND_COOLDOWN_S);
    try {
      const r = await api.post<{ message: string; devOtp?: string }>('/api/auth/resend-otp', { email });
      setResendMsg(r.message);
      if (r.devOtp && /^\d{6}$/.test(r.devOtp)) setDigits(r.devOtp.split(''));
    } catch (err) {
      setResendMsg(err instanceof Error ? err.message : 'Could not send a new code');
    }
  }

  return (
    <AuthShell>
      <div className="authBack">
        <Link className="btn sm" to="/">← Back to sign in</Link>
      </div>
      <h2>Verify your email</h2>
      <p className="hint" style={{ maxWidth: '44ch' }}>
        We sent a 6-digit code to <b>{email}</b>. Enter it below to activate your account.
      </p>

      <form onSubmit={onSubmit} noValidate>
        <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'space-between' }}>
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => { boxes.current[i] = el; }}
              inputMode="numeric"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              maxLength={1}
              value={d}
              disabled={busy}
              onChange={(e) => onChange(i, e.target.value)}
              onKeyDown={(e) => onKeyDown(i, e)}
              onPaste={onPaste}
              className="mono"
              style={{
                width: '100%',
                textAlign: 'center',
                fontSize: 26,
                fontWeight: 700,
                padding: '14px 0',
                letterSpacing: 0,
              }}
            />
          ))}
        </div>

        {error && <div className="errbox" style={{ marginTop: 14 }}>{error}</div>}

        <button
          className="btn primary"
          style={{ width: '100%', marginTop: 16, justifyContent: 'center' }}
          disabled={busy || !complete}
        >
          {busy ? 'Verifying…' : 'Verify & continue'}
        </button>
      </form>

      <div className="rowflex" style={{ marginTop: 16, justifyContent: 'space-between' }}>
        <span className="hint" style={{ margin: 0 }}>Didn't get it? Check spam, or</span>
        <button
          type="button"
          className="btn sm"
          onClick={resend}
          disabled={cooldown > 0}
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
        </button>
      </div>

      {resendMsg && <div className="note" style={{ marginTop: 12 }}>{resendMsg}</div>}

      {devOtp && (
        <div className="note warn" style={{ marginTop: 12 }}>
          <b>DEV_ECHO_LINKS is on.</b> No mail transport is configured, so the code was returned by
          the server and pre-filled above. This is refused outright in production.
        </div>
      )}
    </AuthShell>
  );
}
