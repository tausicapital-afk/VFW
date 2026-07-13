import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { AuthShell } from './Signup';

/**
 * Ask for a reset link.
 *
 * The reply is the same whether or not the address is registered — anything else
 * would let a stranger enumerate who works here. If the server has no mail
 * transport configured it answers 503, and that failure is shown honestly rather
 * than dressed up as success.
 */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string; devResetToken?: string }>(
        '/api/auth/forgot-password',
        { email: email.trim().toLowerCase() },
      );
      setSent(r.message);
      setDevToken(r.devResetToken ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a reset link');
    }
    setBusy(false);
  }

  return (
    <AuthShell>
      <div className="authBack">
        <Link className="btn sm" to="/">← Back to sign in</Link>
      </div>
      <h2>Reset your password</h2>
      <p className="hint">Enter the email on your account. If it matches, we will send a reset link.</p>

      <form onSubmit={onSubmit} noValidate>
        <div className="f">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <button
          className="btn primary"
          style={{ width: '100%', marginTop: 14, justifyContent: 'center' }}
          disabled={busy}
        >
          {busy ? 'Sending…' : 'Send reset link'}
        </button>
      </form>

      {sent && <div className="note" style={{ marginTop: 16 }}>{sent}</div>}

      {devToken && (
        <div className="note warn" style={{ marginTop: 10 }}>
          <b>DEV_ECHO_LINKS is on.</b> No mail transport is configured, so the server returned the
          token instead of emailing it. This is refused outright in production.
          <br />
          <Link className="btn sm" style={{ marginTop: 8 }} to={`/reset?token=${devToken}`}>
            Open reset link
          </Link>
        </div>
      )}

      {error && <div className="note bad" style={{ marginTop: 16 }}>{error}</div>}
    </AuthShell>
  );
}

/**
 * Redeem a reset token. The token is single-use and expiring, and both are
 * enforced server-side as one atomic update — a second attempt with the same
 * link fails, whatever this screen believes.
 */
export function ResetPassword() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setError('Password must be at least 8 characters');
    if (password !== password2) return setError('Passwords do not match');

    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/reset-password', { token, password });
      setDone(true);
      setTimeout(() => nav('/'), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This reset link is invalid or has expired');
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthShell>
        <h2>Link expired</h2>
        <p className="hint">This reset link is invalid or has expired.</p>
        <Link className="btn primary" style={{ marginTop: 14 }} to="/forgot">
          Request a new link
        </Link>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell>
        <div className="pendingIcon">✓</div>
        <h2>Password updated</h2>
        <p className="hint">
          That link has now been used and will not work again. Sign in with your new password.
        </p>
        <Link className="btn primary" style={{ marginTop: 14 }} to="/">Sign in</Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h2>Choose a new password</h2>
      <p className="hint">This link can only be used once.</p>

      <form onSubmit={onSubmit} noValidate>
        <div className="f">
          <label>New password</label>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <div className="f" style={{ marginTop: 10 }}>
          <label>Confirm password</label>
          <input
            type="password"
            autoComplete="new-password"
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            required
          />
        </div>

        {error && <div className="errbox" style={{ marginTop: 12 }}>{error}</div>}

        <button
          className="btn primary"
          style={{ width: '100%', marginTop: 14, justifyContent: 'center' }}
          disabled={busy}
        >
          {busy ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </AuthShell>
  );
}
