import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useToast } from '../shell/Toast';

export function Login() {
  const { login, completeTotp } = useAuth();
  const { showSuccess, showError } = useToast();
  const [params, setParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The password step (below) can also hand back a challenge, but a Google
  // sign-in has no SPA request to return one to — it lands here as a full
  // page redirect, so GoogleSsoService/AuthController pass it as a query
  // param instead. Either path ends up in the same state.
  const [challenge, setChallenge] = useState<string | null>(() => params.get('totp'));

  useEffect(() => {
    const ssoError = params.get('ssoError');
    if (ssoError) {
      showError(ssoError);
      const next = new URLSearchParams(params);
      next.delete('ssoError');
      setParams(next, { replace: true });
    }
    // Only on the params this page was actually loaded with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email, password, remember);
      if (result.totpRequired) {
        setChallenge(result.challenge);
        setBusy(false);
        return;
      }
      // No navigate() here: once the session lands, App swaps the whole tree.
      // The toast provider sits outside the router, so this survives the swap
      // and lands on the dashboard.
      showSuccess('Signed in.', 'Welcome back');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not sign in';
      // Both: the toast is what catches the eye, the inline note is what stays
      // put next to the fields while the password is retyped.
      showError(message);
      setError(message);
      setBusy(false);
    }
  }

  if (challenge) {
    return (
      <TotpChallenge
        onBack={() => {
          setChallenge(null);
          const next = new URLSearchParams(params);
          next.delete('totp');
          setParams(next, { replace: true });
        }}
        onSubmit={async (code) => {
          await completeTotp(challenge, code);
          // The challenge travelled here as `?totp=` for the Google-redirect
          // path (see the field above) and, unlike a plain navigate, nothing
          // else clears it once the session lands — App swaps the whole tree
          // instead of routing away. Strip it so a bearer-like token does not
          // linger in the address bar/history after it has been consumed.
          const next = new URLSearchParams(params);
          next.delete('totp');
          setParams(next, { replace: true });
          showSuccess('Signed in.', 'Welcome back');
        }}
      />
    );
  }

  return (
    <section id="login">
      <div className="stage">
        <div className="rowflex" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div className="mark">VFW</div>
          {/* Full page nav on purpose, not a router Link: /api/health is a
              server-rendered page from the backend, not an SPA route. */}
          <a className="statusLink" href="/api/health">Status</a>
        </div>
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
            <div className="pw">
              <input
                id="pw"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="pw-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                <EyeIcon off={showPassword} />
              </button>
            </div>
          </div>

          <label className="chk" style={{ marginTop: 12 }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span className="t">Keep me signed in for 30 days</span>
          </label>

          <div className="rowflex" style={{ marginTop: 12, justifyContent: 'space-between' }}>
            <Link className="sm" to="/forgot">Forgot password?</Link>
            <Link className="sm" to="/signup">Have an invitation code?</Link>
          </div>

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
        </form>

        <div className="rowflex" style={{ margin: '16px 0', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, height: 1, background: 'var(--line, #2a2a30)' }} />
          <span className="mut sm">or</span>
          <div style={{ flex: 1, height: 1, background: 'var(--line, #2a2a30)' }} />
        </div>

        {/* Full page nav, not a fetch: this hands the browser off to Google and
            comes back via a server redirect (see AuthController.googleCallback),
            so there is no SPA request to attach a handler to. */}
        <a
          className="btn"
          style={{ width: '100%', justifyContent: 'center' }}
          href="/api/auth/google"
        >
          Sign in with Google Workspace
        </a>
      </div>
    </section>
  );
}

/**
 * The second step of a TOTP login. Shown either after a password login comes
 * back `totpRequired`, or straight away when the page loads with `?totp=` —
 * which is how a Google sign-in for a 2FA-enrolled account arrives here (see
 * Login()'s `challenge` state above).
 */
function TotpChallenge({
  onSubmit,
  onBack,
}: {
  onSubmit: (code: string) => Promise<void>;
  onBack: () => void;
}) {
  const { showError } = useToast();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'That code could not be verified';
      showError(message);
      setError(message);
      setCode('');
      setBusy(false);
    }
  }

  return (
    <section id="login">
      <div className="stage">
        <div className="mark">VFW</div>
        <div>
          <h1>
            One more<br />step.
          </h1>
          <p className="sub">
            Enter the 6-digit code from your authenticator app to finish signing in.
          </p>
        </div>
      </div>

      <div className="panel">
        <form onSubmit={submit}>
          <h2>Enter your code</h2>
          <div className="f">
            <label htmlFor="totp">Authentication code</label>
            <input
              id="totp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="mono"
              style={{ letterSpacing: 4, fontSize: 20, textAlign: 'center' }}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              autoFocus
              required
            />
          </div>

          {error && (
            <div className="note bad" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}

          <button
            className="btn primary"
            style={{ marginTop: 16, width: '100%', justifyContent: 'center' }}
            disabled={busy || code.length !== 6}
          >
            {busy ? 'Verifying…' : 'Verify & continue'}
          </button>
          <button
            type="button"
            className="btn sm"
            style={{ marginTop: 12, width: '100%', justifyContent: 'center' }}
            onClick={onBack}
          >
            ← Back to sign in
          </button>
        </form>
      </div>
    </section>
  );
}

/* The design system's icons are unicode glyphs, but there is no eye among them —
   and the emoji one renders in colour, which would clash. This is the same
   monochrome stroke weight, drawn inline so it inherits currentColor. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M1.8 12S5.8 5 12 5s10.2 7 10.2 7-4 7-10.2 7S1.8 12 1.8 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <line x1="4" y1="20" x2="20" y2="4" />}
    </svg>
  );
}
