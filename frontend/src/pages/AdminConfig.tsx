import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type {
  ConfigField, ConfigGroup, ConfigState, ConfigTestResult, EnvPanelRow,
  MailAccount, MailAccountInput, MailAccountsState,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Configuration — the mailboxes the app sends from, plus storage credentials
// and email appearance, all settable by a non-technical admin.
//
// The groups are rendered entirely from the backend registry (GET
// /api/admin/config): the server describes the fields, this only draws them.
// Secrets are write-only — their value is never sent to the browser, so the
// input shows "set / not set" and stays blank unless the admin is replacing it.
//
// Mail accounts are their own thing (GET /api/admin/mail-accounts) rather than
// registry fields, because there can be several of them and one is active.
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

      <MailAccountsCard />

      {data.groups.map((g) => (
        <ConfigGroupCard key={g.id} group={g} onSaved={refresh} />
      ))}

      <EnvPanel rows={data.env} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Mail accounts
// ---------------------------------------------------------------------------

const BLANK: MailAccountInput = {
  label: '', host: '', port: 465, encryption: 'ssl',
  username: '', password: '', fromAddress: '', fromName: '',
};

function MailAccountsCard() {
  const qc = useQueryClient();
  const key = ['admin', 'mail-accounts'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<MailAccountsState>('/api/admin/mail-accounts'),
  });

  // Which row is open in the editor: an id, 'new', or nothing.
  const [editing, setEditing] = useState<string | null>(null);
  const [test, setTest] = useState<Record<string, ConfigTestResult>>({});
  const [error, setError] = useState<string | null>(null);

  // Every mutation returns the whole list, so the cache is replaced rather than
  // patched — activating one row deactivates another, and a per-row update would
  // leave two rows drawn as active until the next refetch.
  const write = (fn: () => Promise<MailAccountsState>) =>
    fn()
      .then((next) => { qc.setQueryData(key, next); setError(null); setEditing(null); })
      .catch((e: Error) => setError(e.message));

  const activate = (id: string) =>
    void write(() => api.post<MailAccountsState>(`/api/admin/mail-accounts/${id}/activate`));

  const remove = (id: string, label: string) => {
    if (!confirm(`Remove the mail account "${label}"? Its password is not recoverable afterwards.`)) return;
    void write(() => api.del<MailAccountsState>(`/api/admin/mail-accounts/${id}`));
  };

  const runTest = (id: string) => {
    setTest((t) => ({ ...t, [id]: { ok: false, error: 'Sending…' } }));
    api.post<ConfigTestResult>(`/api/admin/mail-accounts/${id}/test`)
      .then((r) => setTest((t) => ({ ...t, [id]: r })))
      .catch((e: Error) => setTest((t) => ({ ...t, [id]: { ok: false, error: e.message } })));
  };

  if (!data) return null;
  const { accounts, status } = data;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="hd">
        <h3>Mail accounts</h3>
        <div className="sp" style={{ flex: 1 }} />
        <span className={'pill ' + (status.source === 'none' ? 'RETURNED' : 'APPROVED')}>
          {status.source === 'account' ? 'Sending' : status.source === 'legacy' ? 'Legacy settings' : 'Not configured'}
        </span>
      </div>
      <div className="bd">
        <p className="sm mut" style={{ marginTop: 0 }}>
          The mailboxes this console can send from — sign-up codes, password resets and
          invitations. Keep as many as you like; the <b>active</b> one sends. Test a mailbox
          before making it active.
        </p>

        {status.source === 'legacy' && (
          <div className="note" style={{ marginTop: 0, marginBottom: 12 }}>
            Email is still running on the older <span className="mono">MAIL_*</span> settings.
            They keep working — adding your first account below takes over from them.
          </div>
        )}
        {status.source === 'none' && (
          <div className="note warn" style={{ marginTop: 0, marginBottom: 12 }}>
            <b>No mailbox is configured.</b> Sign-up codes, password resets and invitation emails
            will fail until you add one.
          </div>
        )}
        {error && <div className="note bad" style={{ marginBottom: 12 }}>{error}</div>}

        {accounts.map((a) => (
          <div key={a.id}>
            <MailAccountRow
              account={a}
              onActivate={() => activate(a.id)}
              onEdit={() => setEditing(editing === a.id ? null : a.id)}
              onRemove={() => remove(a.id, a.label)}
              onTest={() => runTest(a.id)}
              editing={editing === a.id}
              test={test[a.id]}
            />
            {editing === a.id && (
              <MailAccountForm
                account={a}
                onCancel={() => setEditing(null)}
                onSave={(body) =>
                  write(() => api.patch<MailAccountsState>(`/api/admin/mail-accounts/${a.id}`, body))
                }
              />
            )}
          </div>
        ))}

        {editing === 'new' ? (
          <MailAccountForm
            onCancel={() => setEditing(null)}
            onSave={(body) => write(() => api.post<MailAccountsState>('/api/admin/mail-accounts', body))}
          />
        ) : (
          <button className="btn" style={{ marginTop: 12 }} onClick={() => setEditing('new')}>
            + Add account
          </button>
        )}
      </div>
    </div>
  );
}

function MailAccountRow({
  account, onActivate, onEdit, onRemove, onTest, editing, test,
}: {
  account: MailAccount;
  onActivate: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onTest: () => void;
  editing: boolean;
  test?: ConfigTestResult;
}) {
  return (
    <div
      className="rowflex"
      style={{
        gap: 12, alignItems: 'flex-start', padding: '12px 0',
        borderTop: '1px solid var(--line)',
      }}
    >
      <div style={{ paddingTop: 2 }}>
        <input
          type="radio"
          name="active-mail-account"
          checked={account.isActive}
          onChange={onActivate}
          aria-label={`Send from ${account.label}`}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="b">
          {account.label}
          {account.isActive && <span className="pill APPROVED" style={{ marginLeft: 8 }}>Active</span>}
        </div>
        <div className="sm mut mono" style={{ wordBreak: 'break-all' }}>
          {account.fromAddress} · {account.host}:{account.port} {account.encryption}
        </div>
        {account.decryptError && (
          <div className="note bad" style={{ marginTop: 8 }}>
            Its password can no longer be read — the server&apos;s encryption key changed. Edit the
            account and enter the password again.
          </div>
        )}
        {test && (
          <div className={'note ' + (test.ok ? 'good' : 'bad')} style={{ marginTop: 8 }}>
            {test.ok ? `Test email sent to ${test.sentTo}. Check your inbox.` : test.error}
          </div>
        )}
      </div>
      <div className="rowflex" style={{ gap: 8 }}>
        <button className="btn" onClick={onTest}>Send test</button>
        <button className="btn" onClick={onEdit}>{editing ? 'Close' : 'Edit'}</button>
        <button className="btn" onClick={onRemove}>Remove</button>
      </div>
    </div>
  );
}

function MailAccountForm({
  account, onSave, onCancel,
}: {
  account?: MailAccount;
  onSave: (body: MailAccountInput) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<MailAccountInput>(
    account
      ? {
          label: account.label, host: account.host, port: account.port,
          encryption: account.encryption, username: account.username,
          password: '', fromAddress: account.fromAddress, fromName: account.fromName ?? '',
        }
      : BLANK,
  );
  const set = (k: keyof MailAccountInput) => (e: { target: { value: string } }) =>
    setF((p) => ({ ...p, [k]: k === 'port' ? Number(e.target.value) : e.target.value }));

  const isNew = !account;
  const complete = f.label && f.host && f.username && f.fromAddress && (isNew ? f.password : true);

  return (
    <div style={{ padding: '12px 0 4px 30px' }}>
      <div className="fields">
        <div className="f">
          <label>Name</label>
          <input value={f.label} onChange={set('label')} placeholder="VFW (cPanel)" />
          <div className="help">What you call this mailbox here. Recipients never see it.</div>
        </div>
        <div className="f">
          <label>SMTP server</label>
          <input value={f.host} onChange={set('host')} placeholder="mail.yourdomain.com" />
          <div className="help">A hostname — not an email address. cPanel: mail.yourdomain.com. Gmail: smtp.gmail.com.</div>
        </div>
        <div className="f">
          <label>Port</label>
          <input type="number" value={f.port} onChange={set('port')} placeholder="465" />
          <div className="help">465 for SSL, 587 for TLS/STARTTLS.</div>
        </div>
        <div className="f">
          <label>Encryption</label>
          <select value={f.encryption} onChange={set('encryption')}>
            <option value="ssl">ssl</option>
            <option value="tls">tls</option>
            <option value="none">none</option>
          </select>
          <div className="help">ssl for port 465, tls for 587.</div>
        </div>
        <div className="f">
          <label>Username</label>
          <input value={f.username} onChange={set('username')} placeholder="no-reply@yourdomain.com" />
          <div className="help">The mailbox the app signs in to — usually the full email address.</div>
        </div>
        <div className="f">
          <label>Password</label>
          <input
            type="password"
            autoComplete="new-password"
            value={f.password}
            onChange={set('password')}
            placeholder={isNew ? '' : '•••••••• (set — leave blank to keep)'}
          />
          <div className="help">
            Stored encrypted. Gmail needs a 16-character App Password, not the account password.
          </div>
        </div>
        <div className="f">
          <label>From address</label>
          <input value={f.fromAddress} onChange={set('fromAddress')} placeholder="no-reply@yourdomain.com" />
          <div className="help">The address recipients see. Usually the same as the username.</div>
        </div>
        <div className="f">
          <label>Sender name</label>
          <input value={f.fromName} onChange={set('fromName')} placeholder="VFW Console" />
          <div className="help">
            The brand at the top of emails from this account. Blank uses the default brand name below.
          </div>
        </div>
      </div>
      <div className="rowflex" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn primary" disabled={!complete} onClick={() => onSave(f)}>
          {isNew ? 'Add account' : 'Save changes'}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
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
    mutationFn: () => api.post<ConfigTestResult>('/api/admin/config/test/storage'),
    onSuccess: (r) => setTest(r),
    onError: (e: Error) => setTest({ ok: false, error: e.message }),
  });

  // Only storage is testable from its group card. Email is tested per mailbox,
  // from the row that owns the credentials being tested.
  const testable = group.id === 'storage';

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="hd">
        <h3>{group.title}</h3>
        <div className="sp" style={{ flex: 1 }} />
        {group.configured !== null && (
          <span className={'pill ' + (group.configured ? 'APPROVED' : 'RETURNED')}>
            {group.configured ? 'Configured' : 'Not configured'}
          </span>
        )}
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
        {testable && (
          <button
            className="btn"
            disabled={runTest.isPending}
            onClick={() => { setTest(null); runTest.mutate(); }}
            title="Tests the settings currently saved on the server"
          >
            {runTest.isPending ? 'Testing…' : 'Test connection'}
          </button>
        )}
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
