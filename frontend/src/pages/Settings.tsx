import { useAuth } from '../auth/AuthContext';
import { useTestHighlight } from '../lib/testData';
import { useTheme, type ThemePref } from '../theme/ThemeContext';
import { Page } from '../shell/Shell';

const THEME_OPTIONS: { value: ThemePref; label: string; hint: string; ic: string }[] = [
  { value: 'light', label: 'Light', hint: 'Front-of-house', ic: '☀' },
  { value: 'dark', label: 'Dark', hint: 'Backstage', ic: '☾' },
  { value: 'system', label: 'System', hint: 'Match device', ic: '◐' },
];

export function Settings() {
  const { user } = useAuth();
  const { theme, resolved, setTheme } = useTheme();
  const { on: highlightTest, setOn: setHighlightTest } = useTestHighlight();

  return (
    <Page crumb="Console" title="Settings">
      <div className="grid" style={{ maxWidth: 720 }}>
        <div className="card">
          <div className="hd"><h3>Appearance</h3></div>
          <div className="bd">
            <div className="f" style={{ marginBottom: 12 }}>
              <label>Theme</label>
              <div className="help" style={{ marginBottom: 10 }}>
                Choose a colour scheme. “System” follows your device and switches automatically.
              </div>
              <div className="theme-choices">
                {THEME_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={'theme-choice' + (theme === opt.value ? ' on' : '')}
                    onClick={() => setTheme(opt.value)}
                    aria-pressed={theme === opt.value}
                  >
                    <span className="ic">{opt.ic}</span>
                    <span className="lb">{opt.label}</span>
                    <span className="hint">{opt.hint}</span>
                  </button>
                ))}
              </div>
              <div className="help" style={{ marginTop: 10 }}>
                Currently showing the <b>{resolved}</b> theme.
              </div>
            </div>

            {/* Sits under Appearance rather than in a card of its own: it is a
                display preference like the theme, stored in this browser, and
                it changes nothing about the records themselves. */}
            <div className="f">
              <label>Test data</label>
              <div className="help" style={{ marginBottom: 10 }}>
                Demo and rehearsal records share this database with real ones. When this is on,
                every table tints those rows and marks them <b>Test</b>.
              </div>
              <label className="chk">
                <input
                  type="checkbox"
                  checked={highlightTest}
                  onChange={(e) => setHighlightTest(e.target.checked)}
                />
                <span className="t">
                  Highlight test data in tables
                  <div className="sm mut">
                    Turning this off hides the marking for you only — it does not change any
                    record, and nobody else&apos;s screen is affected.
                  </div>
                </span>
              </label>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="hd"><h3>Signed in as</h3></div>
          <div className="bd">
            <div className="mut sm">{user?.name} · {user?.email}</div>
            <p className="sm" style={{ marginTop: 8 }}>
              Manage your profile details on the <a href="/account">Account</a> screen.
            </p>
          </div>
        </div>
      </div>
    </Page>
  );
}
