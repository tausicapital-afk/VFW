import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password, remember);
      // No navigate() here: once the session lands, App swaps the whole tree.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
      setBusy(false);
    }
  }

  return (
    <section id="login">
      <div className="stage">
        <div className="mark">VFW</div>
        <div>
          <h1>
            Sales<br />runs on a<br /><em>system</em>,<br />not email.
          </h1>
          <p className="sub">
            The internal console for submissions, accounting review, QuickBooks hand-off and
            sales performance across every VFW Management show.
          </p>
          <div className="brands">
            <span>Vancouver Fashion Week</span>
            <span>Vancouver Kids</span>
            <span>Global Fashion Collective</span>
          </div>
        </div>
        <div className="sub sm">
          VFW Management Inc. · Suite 403 – 938 Howe Street, Vancouver BC
        </div>
      </div>

      <div className="panel">
        <form onSubmit={onSubmit}>
          <h2>Sign in</h2>

          <div className="f">
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="f" style={{ marginTop: 12 }}>
            <label htmlFor="pw">Password</label>
            <input
              id="pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <label className="chk" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span className="t">Keep me signed in for 30 days</span>
          </label>

          {error && (
            <div className="note bad" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}

          <button
            className="btn primary"
            style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}
            disabled={busy}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="hint" style={{ marginTop: 14 }}>
            Demo accounts — password <code>Vfw@2026!</code>
            <br />
            <code>marielle@vanfashionweek.com</code> (Sales)
            <br />
            <code>accounting@vanfashionweek.com</code> (Accounting)
          </p>
        </form>
      </div>
    </section>
  );
}
