import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';

const DEPARTMENTS = [
  'Sales', 'Accounting', 'Marketing', 'Production', 'Media', 'International', 'Administration',
];

/**
 * The signed-out shell. Reuses #login's two-panel layout from console.css — the
 * signup, forgot and reset screens are the same furniture with a different form
 * in the right-hand panel, exactly as the mockup does it (showAuth, line 611).
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <section id="login">
      <div className="stage">
        <div className="mark">VFW</div>
        <div>
          <h1>Sales<br />runs on a<br /><em>system</em>,<br />not email.</h1>
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
      <div className="panel">{children}</div>
    </section>
  );
}

export function Signup() {
  const { code: codeParam } = useParams<{ code: string }>();
  const nav = useNavigate();

  const [code, setCode] = useState((codeParam ?? '').toUpperCase());
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [department, setDepartment] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();

    // Client-side checks are courtesy only — the server re-runs all of them,
    // and the role comes from the invitation regardless of what is posted.
    const errs: string[] = [];
    if (!code.trim()) errs.push('Invitation code is required');
    if (!name.trim()) errs.push('Full name is required');
    if (!email.trim()) errs.push('A valid email is required');
    if (password.length < 8) errs.push('Password must be at least 8 characters');
    if (password !== password2) errs.push('Passwords do not match');
    if (errs.length) { setErrors(errs); return; }

    setErrors([]);
    setBusy(true);
    const addr = email.trim().toLowerCase();
    try {
      const r = await api.post<{ email: string; otpRequired: true; devOtp?: string }>(
        '/api/auth/signup',
        {
          code: code.trim().toUpperCase(),
          name: name.trim(),
          email: addr,
          password,
          phone: phone.trim() || undefined,
          department: department || undefined,
        },
      );
      // A welcome email with a 6-digit code is on its way. Hand the address (and,
      // in dev-echo mode, the code) to the verification screen via router state.
      nav('/verify', { replace: true, state: { email: r.email, devOtp: r.devOtp } });
    } catch (err) {
      setErrors([err instanceof Error ? err.message : 'Could not create that account']);
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <div className="authBack">
        <Link className="btn sm" to="/">← Back to sign in</Link>
      </div>
      <h2>Create your account</h2>
      <p className="hint">Registration is invitation-only. Enter the code from your invitation.</p>

      <form onSubmit={onSubmit} noValidate>
        <div className="f">
          <label>Invitation code <span className="req">*</span></label>
          <input
            className="mono"
            style={{ textTransform: 'uppercase' }}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="VFW-XXXXXX"
            required
          />
          <div className="help">Your role and department come from the invitation.</div>
        </div>

        <div className="fields" style={{ marginTop: 14 }}>
          <div className="f wide">
            <label>Full name <span className="req">*</span></label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="f">
            <label>Email <span className="req">*</span></label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="f">
            <label>Phone</label>
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 604 555 0100" />
          </div>
          <div className="f">
            <label>Password <span className="req">*</span></label>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <div className="help">At least 8 characters.</div>
          </div>
          <div className="f">
            <label>Confirm password <span className="req">*</span></label>
            <input
              type="password"
              autoComplete="new-password"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              required
            />
          </div>
          <div className="f">
            <label>Department</label>
            <select value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">— from the invitation —</option>
              {DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
            </select>
          </div>
        </div>

        {errors.length > 0 && (
          <div className="errbox" style={{ marginTop: 14 }}>
            <b>{errors.length} item{errors.length > 1 ? 's' : ''} to fix</b>
            <ul>{errors.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}

        <button
          className="btn primary"
          style={{ width: '100%', marginTop: 16, justifyContent: 'center' }}
          disabled={busy}
        >
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </AuthShell>
  );
}
