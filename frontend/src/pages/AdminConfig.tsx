import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type {
  ConfigField, ConfigGroup, ConfigState, ConfigTestResult, EnvPanelRow,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Configuration — SMTP & storage credentials a non-technical admin can set.
//
// Rendered entirely from the backend registry (GET /api/admin/config): the
// server describes the fields, this only draws them. Secrets are write-only —
// their value is never sent to the browser, so the input shows "set / not set"
// and stays blank unless the admin is replacing it.
// ---------------------------------------------------------------------------

export function ConfigTab() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['admin', 'config'],
    queryFn: () => api.get<ConfigState>('/api/admin/config'),
  });

  if (!data) return <div className="empty"><h3>Loading…</h3></div>;

  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin', 'config'] });

  return (
    <>
      <div className="note" style={{ marginBottom: 16 }}>
        These are the credentials the app needs to send email and store documents. They save
        straight to the database — no redeploy — and take effect immediately. <b>Passwords and
        secret keys are encrypted</b> and never shown again once saved; leave a secret field blank
        to keep the current value.
      </div>

      {data.groups.map((g) => (
        <ConfigGroupCard key={g.id} group={g} onSaved={refresh} />
      ))}

      <EnvPanel rows={data.env} />
    </>
  );
}

function sourceHint(field: ConfigField): string | null {
  const s = field.state;
  if (s.decryptError) return 'Stored but unreadable — re-enter it';
  if (s.source === 'db') return 'Set here';
  if (s.source === 'env') return 'From server environment';
  return null;
}

function ConfigGroupCard({ group, onSaved }: { group: ConfigGroup; onSaved: () => void }) {
  // Draft holds only what the admin types. Non-secret fields seed from their
  // current value; secret fields always start blank (write-only). We diff
  // against the seed so an untouched field is never re-sent — that keeps an
  // env-sourced value from being silently copied into a database row.
  const init = useCallback((): Record<string, string> => {
    const d: Record<string, string> = {};
    for (const f of group.fields) d[f.key] = f.type === 'secret' ? '' : (f.state.value ?? '');
    return d;
  }, [group]);

  const [draft, setDraft] = useState<Record<string, string>>(init);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<ConfigTestResult | null>(null);

  useEffect(() => { setDraft(init()); setSaved(false); setTest(null); }, [init]);

  const initial = init();
  const changed = Object.fromEntries(
    Object.entries(draft).filter(([k, v]) => v !== initial[k]),
  );
  const dirty = Object.keys(changed).length > 0;

  const save = useMutation({
    mutationFn: () => api.patch('/api/admin/config', { entries: changed }),
    onSuccess: () => { setSaved(true); setError(null); onSaved(); },
    onError: (e: Error) => { setSaved(false); setError(e.message); },
  });

  const runTest = useMutation({
    mutationFn: () =>
      api.post<ConfigTestResult>(
        `/api/admin/config/test/${group.id === 'email' ? 'email' : 'storage'}`,
      ),
    onSuccess: (r) => setTest(r),
    onError: (e: Error) => setTest({ ok: false, error: e.message }),
  });

  const testLabel = group.id === 'email' ? 'Send test email' : 'Test connection';

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="hd">
        <h3>{group.title}</h3>
        <div className="sp" style={{ flex: 1 }} />
        <span className={'pill ' + (group.configured ? 'APPROVED' : 'RETURNED')}>
          {group.configured ? 'Configured' : 'Not configured'}
        </span>
      </div>
      <div className="bd">
        <p className="sm mut" style={{ marginTop: 0 }}>{group.blurb}</p>
        <div className="fields">
          {group.fields.map((f) => (
            <ConfigFieldInput
              key={f.key}
              field={f}
              value={draft[f.key] ?? ''}
              onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
            />
          ))}
        </div>

        {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        {saved && !error && (
          <div className="note good" style={{ marginTop: 12 }}>Saved. The change is live now.</div>
        )}
        {test && (
          <div className={'note ' + (test.ok ? 'good' : 'bad')} style={{ marginTop: 12 }}>
            {test.ok
              ? (test.sentTo
                  ? `Test email sent to ${test.sentTo}. Check your inbox.`
                  : 'Connection succeeded.')
              : `Test failed: ${test.error}`}
          </div>
        )}
      </div>
      <div className="ft">
        <button
          className="btn"
          disabled={runTest.isPending}
          onClick={() => { setTest(null); runTest.mutate(); }}
          title="Tests the settings currently saved on the server"
        >
          {runTest.isPending ? 'Testing…' : testLabel}
        </button>
        <button
          className="btn primary"
          disabled={!dirty || save.isPending}
          onClick={() => { setError(null); setSaved(false); save.mutate(); }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ConfigFieldInput({
  field, value, onChange,
}: {
  field: ConfigField;
  value: string;
  onChange: (v: string) => void;
}) {
  const hint = sourceHint(field);
  const wide = field.key === 'R2_ENDPOINT' || field.key === 'APP_URL';

  let input;
  if (field.type === 'select') {
    input = (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {!field.options?.includes(value) && <option value="">—</option>}
        {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (field.type === 'secret') {
    input = (
      <input
        type="password"
        autoComplete="new-password"
        value={value}
        placeholder={field.state.isSet ? '•••••••• (set — leave blank to keep)' : 'Not set'}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else if (field.type === 'color') {
    input = (
      <div className="rowflex" style={{ gap: 8, alignItems: 'center' }}>
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#0C7A4D'}
          style={{ width: 44, height: 34, padding: 2 }}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          value={value}
          placeholder={field.placeholder}
          style={{ flex: 1 }}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  } else {
    input = (
      <input
        type={field.type === 'number' ? 'number' : 'text'}
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className={'f' + (wide ? ' wide' : '')}>
      <label>
        {field.label}
        {field.required && <span style={{ color: 'var(--red)' }}> *</span>}
        {hint && <span className="sm mut" style={{ fontWeight: 400 }}> · {hint}</span>}
      </label>
      {input}
      {field.help && <div className="help">{field.help}</div>}
    </div>
  );
}

function EnvPanel({ rows }: { rows: EnvPanelRow[] }) {
  return (
    <div className="card">
      <div className="hd">
        <h3>Server environment</h3>
        <div className="sp" />
        <span className="sm mut">Read-only — set by your host</span>
      </div>
      <div className="bd">
        <div className="note" style={{ marginTop: 0, marginBottom: 12 }}>
          These are set where the app is hosted (Railway variables / secrets) and can&apos;t be
          changed here — some are needed before the database is even reachable, and others are
          security-sensitive. They&apos;re shown so you can confirm what&apos;s set; ask a developer
          to change one.
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr><th>Setting</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className="b">{r.label}<div className="sm mut mono">{r.key}</div></td>
                  <td>
                    {r.isSet ? (
                      <span className="pill APPROVED">{r.secret ? 'Set' : (r.value || 'Set')}</span>
                    ) : (
                      <span className="pill RETURNED">Not set</span>
                    )}
                  </td>
                  <td className="sm mut">{r.help}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
