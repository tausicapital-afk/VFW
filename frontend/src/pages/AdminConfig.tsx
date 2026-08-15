import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import type {
  AdminCatalogue, ConfigField, ConfigGroup, ConfigState, ConfigTestResult, EnvPanelRow,
  MailAccount, MailAccountInput, MailAccountsState,
  QboBrowseOption, QboMapping, QboMappingKind, QboStatus,
  TestDataMarkResult, TestDataSummary,
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
        <div key={g.id}>
          <ConfigGroupCard group={g} onSaved={refresh} />
          {/* The backfill sits directly under the switch it completes, rather
              than in a card of its own further down: the switch decides what NEW
              rows are and this decides what old ones were, and reading one
              without the other leaves you thinking the switch did nothing. */}
          {g.id === 'data' && <TestDataCard />}
          {/* Same reasoning as the test-data backfill above: the connection
              card and the mappings it unlocks belong directly under the
              credential fields that make them possible, not in a card of
              their own elsewhere on the page. */}
          {g.id === 'quickbooks' && <QboConnectionCard />}
          {g.id === 'quickbooks' && <QboMappingsCard />}
        </div>
      ))}

      <EnvPanel rows={data.env} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Mail accounts
// ---------------------------------------------------------------------------

const BLANK: MailAccountInput = {
  label: '', provider: 'smtp', host: '', port: 465, encryption: 'ssl',
  username: '', password: '', fromAddress: '', fromName: '',
};

// Mirrors the backend's provider capabilities. The providers do not split in
// two: `relay` goes over HTTPS like `resend` but needs a host (its URL) like
// `smtp`, so "isHttp" alone cannot drive the form.
const usesSmtp = (p: string) => p === 'smtp';
const needsHost = (p: string) => p === 'smtp' || p === 'relay';
const isHttp = (p: string) => p === 'resend' || p === 'relay';

const SECRET_LABEL: Record<string, string> = {
  smtp: 'Password',
  resend: 'API key',
  relay: 'Relay token',
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
          {account.fromAddress} ·{' '}
          {account.provider === 'relay'
            ? `relay ${account.host}`
            : isHttp(account.provider)
              ? `${account.provider} (HTTPS)`
              : `${account.host}:${account.port} ${account.encryption}`}
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
          label: account.label, provider: account.provider, host: account.host, port: account.port,
          encryption: account.encryption, username: account.username,
          password: '', fromAddress: account.fromAddress, fromName: account.fromName ?? '',
        }
      : BLANK,
  );
  const set = (k: keyof MailAccountInput) => (e: { target: { value: string } }) =>
    setF((p) => ({ ...p, [k]: k === 'port' ? Number(e.target.value) : e.target.value }));

  const isNew = !account;
  const smtp = usesSmtp(f.provider);
  const relay = f.provider === 'relay';
  // Changing an existing account's provider swaps what its credential and host
  // MEAN, so the server insists on both again — mirror that rather than letting
  // the admin submit into a 400.
  const providerChanged = !isNew && account!.provider !== f.provider;
  const needsSecret = isNew || providerChanged;
  const complete =
    f.label && f.fromAddress &&
    (!needsHost(f.provider) || f.host) &&
    (!smtp || f.username) &&
    (needsSecret ? f.password : true);

  return (
    <div style={{ padding: '12px 0 4px 30px' }}>
      <div className="fields">
        <div className="f">
          <label>Name</label>
          <input value={f.label} onChange={set('label')} placeholder="VFW (cPanel)" />
          <div className="help">What you call this mailbox here. Recipients never see it.</div>
        </div>
        <div className="f">
          <label>Send using</label>
          <select value={f.provider} onChange={set('provider')}>
            <option value="smtp">SMTP mailbox (cPanel, Gmail, …)</option>
            <option value="relay">Our mail relay (cPanel over HTTPS)</option>
            <option value="resend">Resend (HTTP API)</option>
          </select>
          <div className="help">
            {smtp
              ? 'Dials the mail server directly. Blocked on some hosts — Railway drops all SMTP ports.'
              : relay
                ? 'Posts to our own relay on the cPanel box, which sends it. Works where SMTP is blocked; no third party, no cap.'
                : 'Sends over HTTPS via Resend. Works where SMTP is blocked; needs a verified domain.'}
          </div>
        </div>
        {relay && (
          <div className="f wide">
            <label>Relay URL</label>
            <input value={f.host} onChange={set('host')} placeholder="https://veeb.co.ke/vfw-relay/" />
            <div className="help">
              Where the relay is installed. Must be https:// — the token is sent with every message.
            </div>
          </div>
        )}
        {smtp && (
          <>
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
          </>
        )}
        <div className="f">
          <label>{SECRET_LABEL[f.provider] ?? 'Secret'}</label>
          <input
            type="password"
            autoComplete="new-password"
            value={f.password}
            onChange={set('password')}
            placeholder={
              needsSecret
                ? (f.provider === 'resend' ? 're_…' : '')
                : '•••••••• (set — leave blank to keep)'
            }
          />
          <div className="help">
            {smtp
              ? 'Stored encrypted. Gmail needs a 16-character App Password, not the account password.'
              : relay
                ? 'The RELAY_TOKEN from the relay’s index.php. Stored encrypted.'
                : 'Your Resend API key (starts re_). Stored encrypted.'}
            {providerChanged && ' Required — the stored one belongs to the old provider.'}
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

// ---------------------------------------------------------------------------
// QuickBooks Online — the connection itself, then the mappings it unlocks.
//
// The Client ID/secret/environment fields render for free from the generic
// group loop above (group id 'quickbooks'); those only identify the Intuit
// app. This card is the actual company connection, which needs its own UI
// because it isn't a form field — it's a redirect to Intuit's consent screen
// and back. The redirect back lands on /admin?tab=config&qbo=connected|error,
// which Admin.tsx reads to pick this tab and this card reads to show the
// outcome once.
// ---------------------------------------------------------------------------

function QboConnectionCard() {
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data } = useQuery({
    queryKey: ['admin', 'qbo', 'status'],
    queryFn: () => api.get<QboStatus>('/api/admin/qbo/status'),
  });

  const callbackResult = searchParams.get('qbo');
  const callbackMessage = searchParams.get('qboMessage');

  // The callback already changed the connection server-side by the time the
  // browser lands back here — refetch once rather than trusting a cache that
  // predates the redirect.
  useEffect(() => {
    if (callbackResult) void qc.invalidateQueries({ queryKey: ['admin', 'qbo', 'status'] });
  }, [callbackResult, qc]);

  const dismissCallback = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('qbo');
    next.delete('qboMessage');
    setSearchParams(next, { replace: true });
  };

  const disconnect = useMutation({
    mutationFn: () => api.post<QboStatus>('/api/admin/qbo/disconnect'),
    onSuccess: (s) => qc.setQueryData(['admin', 'qbo', 'status'], s),
  });

  if (!data) return null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="hd">
        <h3>Connection</h3>
        <div className="sp" style={{ flex: 1 }} />
        <span className={'pill ' + (data.connected && !data.refreshTokenExpired ? 'APPROVED' : 'RETURNED')}>
          {data.connected ? (data.refreshTokenExpired ? 'Expired' : 'Connected') : 'Not connected'}
        </span>
      </div>
      <div className="bd">
        {callbackResult === 'connected' && (
          <div className="note good rowflex" style={{ marginTop: 0, marginBottom: 12, gap: 8 }}>
            <span style={{ flex: 1 }}>Connected to QuickBooks Online.</span>
            <button className="btn sm" onClick={dismissCallback}>Dismiss</button>
          </div>
        )}
        {callbackResult === 'error' && (
          <div className="note bad rowflex" style={{ marginTop: 0, marginBottom: 12, gap: 8 }}>
            <span style={{ flex: 1 }}>{callbackMessage || 'Could not connect to QuickBooks.'}</span>
            <button className="btn sm" onClick={dismissCallback}>Dismiss</button>
          </div>
        )}

        {data.connected ? (
          <>
            <p className="sm" style={{ marginTop: 0 }}>
              <b>{data.companyName || data.realmId}</b>{' '}
              <span className="mut">· {data.environment}</span>
            </p>
            <p className="sm mut">Connected {data.connectedAt ? fmtDate(data.connectedAt) : '—'}.</p>
            {data.refreshTokenExpired && (
              <div className="note bad" style={{ marginTop: 8 }}>
                This connection has expired — QuickBooks connections go stale after 100 days
                unused. Reconnect below; exports fall back to recording locally without posting
                until you do.
              </div>
            )}
          </>
        ) : (
          <p className="sm mut" style={{ marginTop: 0 }}>
            Not connected. Exports still move a submission to <b>Exported</b> and allocate an
            invoice number, but nothing is posted to QuickBooks until a company is connected here.
          </p>
        )}
      </div>
      <div className="ft">
        {data.connected && (
          <button
            className="btn"
            disabled={disconnect.isPending}
            onClick={() => {
              if (confirm('Disconnect QuickBooks? Exports go back to recording locally, without posting, until you reconnect.')) {
                disconnect.mutate();
              }
            }}
          >
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
          </button>
        )}
        {/* A plain link, not a mutation: this has to leave the SPA entirely for
            Intuit's consent screen, then come back via the server-side
            redirect above — not something a fetch-based click handler does. */}
        <a className="btn primary" href="/api/admin/qbo/connect">
          {data.connected ? 'Reconnect' : 'Connect to QuickBooks'}
        </a>
      </div>
    </div>
  );
}

const QBO_KIND_LABEL: Record<QboMappingKind, string> = {
  TAX: 'Tax profiles', GL: 'GL accounts', DEPARTMENT: 'Departments',
};
const QBO_KIND_HELP: Record<QboMappingKind, string> = {
  TAX: 'Which QuickBooks tax code an invoice posts under, per VFW tax profile.',
  GL: 'Which QuickBooks income account a new catalogue item is created under, per VFW GL account.',
  DEPARTMENT: 'Which QuickBooks location an invoice is tagged with, per VFW department.',
};
// Mirrors Admin.tsx's DEPARTMENTS — kept as its own small copy rather than a
// cross-file import, since importing it back would make this file and
// Admin.tsx import each other.
const QBO_DEPARTMENTS = [
  'Sales', 'Accounting', 'Marketing', 'Production', 'Media', 'International', 'Administration',
];

/**
 * The local-code -> QuickBooks-object mappings export needs before it will
 * post a line — see QboMapping in schema.prisma for why these can't be
 * inferred. Local codes come from VFW's own catalogue (tax profiles, GL
 * accounts) or the fixed department list, so a mapping can't point at a code
 * that doesn't exist; the QuickBooks side is a live browse of the connected
 * company so it can't point at a QBO object that doesn't exist either.
 */
function QboMappingsCard() {
  const qc = useQueryClient();
  const mappingsKey = ['admin', 'qbo', 'mappings'];

  const { data: status } = useQuery({
    queryKey: ['admin', 'qbo', 'status'],
    queryFn: () => api.get<QboStatus>('/api/admin/qbo/status'),
  });
  const { data: mappings } = useQuery({
    queryKey: mappingsKey,
    queryFn: () => api.get<QboMapping[]>('/api/admin/qbo/mappings'),
  });
  const { data: catalogue } = useQuery({
    queryKey: ['admin', 'catalogue'],
    queryFn: () => api.get<AdminCatalogue>('/api/admin/catalogue'),
  });

  const [kind, setKind] = useState<QboMappingKind>('TAX');
  const [localCode, setLocalCode] = useState('');
  const [qboId, setQboId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: options } = useQuery({
    queryKey: ['admin', 'qbo', 'browse', kind],
    queryFn: () => api.get<QboBrowseOption[]>(`/api/admin/qbo/browse/${kind}`),
    enabled: Boolean(status?.connected),
  });

  const localOptions: { code: string; label: string }[] =
    kind === 'TAX'
      ? (catalogue?.taxes ?? []).map((t) => ({ code: t.code, label: `${t.code} — ${t.label}` }))
      : kind === 'GL'
        ? (catalogue?.glAccounts ?? []).map((g) => ({ code: g.code, label: `${g.code} — ${g.name}` }))
        : QBO_DEPARTMENTS.map((d) => ({ code: d, label: d }));

  const save = useMutation({
    mutationFn: () => {
      const opt = options?.find((o) => o.id === qboId);
      if (!opt) throw new Error('Choose a QuickBooks object to map to.');
      return api.post<QboMapping>('/api/admin/qbo/mappings', {
        kind, localCode, qboId: opt.id, qboLabel: opt.name,
      });
    },
    onSuccess: () => {
      setLocalCode(''); setQboId(''); setError(null);
      void qc.invalidateQueries({ queryKey: mappingsKey });
    },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/api/admin/qbo/mappings/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: mappingsKey }),
  });

  if (!status?.connected) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="hd"><h3>Mappings</h3></div>
        <div className="bd">
          <p className="sm mut" style={{ marginTop: 0, marginBottom: 0 }}>
            Connect QuickBooks above to map tax profiles, GL accounts and departments — the picker
            below reads the connected company's live chart of accounts.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="hd"><h3>Mappings</h3></div>
      <div className="bd">
        <p className="sm mut" style={{ marginTop: 0 }}>
          Export refuses to post a line whose tax profile, GL account or department has no mapping
          here — a clear error beats money landing in the wrong QuickBooks account.
        </p>

        {(Object.keys(QBO_KIND_LABEL) as QboMappingKind[]).map((k) => {
          const rows = (mappings ?? []).filter((m) => m.kind === k);
          if (!rows.length) return null;
          return (
            <div key={k} style={{ marginBottom: 16 }}>
              <div className="b" style={{ marginBottom: 4 }}>{QBO_KIND_LABEL[k]}</div>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th>VFW code</th><th>QuickBooks</th><th /></tr></thead>
                  <tbody>
                    {rows.map((m) => (
                      <tr key={m.id}>
                        <td className="mono sm">{m.localCode}</td>
                        <td>{m.qboLabel}</td>
                        <td>
                          <button className="btn sm" onClick={() => remove.mutate(m.id)}>Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}

        <div className="fields">
          <div className="f">
            <label>Kind</label>
            <select
              value={kind}
              onChange={(e) => { setKind(e.target.value as QboMappingKind); setLocalCode(''); setQboId(''); }}
            >
              <option value="TAX">Tax profile</option>
              <option value="GL">GL account</option>
              <option value="DEPARTMENT">Department</option>
            </select>
            <div className="help">{QBO_KIND_HELP[kind]}</div>
          </div>
          <div className="f">
            <label>VFW {kind === 'TAX' ? 'tax profile' : kind === 'GL' ? 'GL account' : 'department'}</label>
            <select value={localCode} onChange={(e) => setLocalCode(e.target.value)}>
              <option value="">—</option>
              {localOptions.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
            </select>
          </div>
          <div className="f wide">
            <label>QuickBooks {kind === 'TAX' ? 'tax code' : kind === 'GL' ? 'account' : 'location'}</label>
            <select value={qboId} onChange={(e) => setQboId(e.target.value)}>
              <option value="">—</option>
              {options?.map((o) => (
                <option key={o.id} value={o.id}>{o.name}{o.subType ? ` (${o.subType})` : ''}</option>
              ))}
            </select>
          </div>
        </div>
        {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
      </div>
      <div className="ft">
        <button
          className="btn primary"
          disabled={!localCode || !qboId || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? 'Saving…' : 'Add mapping'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test data — the backfill
// ---------------------------------------------------------------------------

const COUNT_LABEL: [keyof TestDataSummary['counts'], string][] = [
  ['submissions', 'submissions'],
  ['contacts', 'contacts'],
  ['payments', 'payments'],
  ['emails', 'emails'],
  ['events', 'shows'],
  ['packages', 'packages'],
  ['addons', 'add-ons'],
  ['attendance', 'timesheet days'],
  ['payroll', 'payroll invoices'],
];

/**
 * Marking records that already exist.
 *
 * The one-click button covers the case this exists for — the demo book that was
 * loaded before anyone thought about flagging it — and the box below it takes
 * references for anything else. Both are the same endpoint; the button just
 * sends no references, which the server reads as "the demo ones".
 *
 * Unmarking is offered next to marking rather than hidden, because the honest
 * consequence of a mistyped reference is that a real sale is now drawn as a
 * rehearsal, and the fix for that has to be one click away.
 */
function TestDataCard() {
  const qc = useQueryClient();
  const key = ['admin', 'test-data'];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api.get<TestDataSummary>('/api/admin/test-data'),
  });

  const [refs, setRefs] = useState('');
  const [result, setResult] = useState<TestDataMarkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: (unmark: boolean) =>
      api.post<TestDataMarkResult>('/api/admin/test-data/mark', {
        // Blank means the demo set. Split on commas AND whitespace, because
        // these get pasted out of a spreadsheet as often as typed.
        refs: refs.split(/[\s,]+/).filter(Boolean),
        unmark,
      }),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
      void qc.invalidateQueries({ queryKey: key });
      // Every module table is now drawing stale flags — drop the lot rather
      // than trying to name the queries a backfill can reach.
      void qc.invalidateQueries();
    },
    onError: (e: Error) => { setResult(null); setError(e.message); },
  });

  if (!data) return null;
  const marked = Object.values(data.counts).reduce((t, n) => t + n, 0);
  const custom = refs.trim().length > 0;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="hd">
        <h3>Mark existing records</h3>
        <div className="sp" style={{ flex: 1 }} />
        <span className={'pill ' + (data.mode ? 'PENDING' : 'DRAFT')}>
          {data.mode ? 'Switch is on' : 'Switch is off'}
        </span>
      </div>
      <div className="bd">
        <p className="sm mut" style={{ marginTop: 0 }}>
          The switch above only affects records created from now on. This marks records that
          already exist — the demo sales the console shipped with, or any references you name.
          Marking a sale also marks its contact, its payments and the emails sent about it.
        </p>

        {marked > 0 ? (
          <div className="testdata-summary">
            {COUNT_LABEL.filter(([k]) => data.counts[k] > 0).map(([k, label]) => (
              <span key={k} className="sm mut">
                <span className="n">{data.counts[k]}</span> {label}
              </span>
            ))}
          </div>
        ) : (
          <div className="sm mut" style={{ marginTop: 10 }}>
            Nothing is currently marked as test data.
          </div>
        )}

        <div className="f" style={{ marginTop: 14 }}>
          <label>References</label>
          <input
            value={refs}
            placeholder={data.demoRefs.join(', ')}
            onChange={(e) => setRefs(e.target.value)}
          />
          <div className="help">
            Submission references, separated by commas or spaces. Leave blank to use the demo
            records ({data.demoRefs.length} sales, shown above as the placeholder).
          </div>
        </div>

        {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        {result && !error && (
          <div className="note good" style={{ marginTop: 12 }}>
            Changed <b>{result.submissions}</b> submission{result.submissions === 1 ? '' : 's'},{' '}
            <b>{result.contacts}</b> contact{result.contacts === 1 ? '' : 's'},{' '}
            <b>{result.payments}</b> payment{result.payments === 1 ? '' : 's'} and{' '}
            <b>{result.emails}</b> email{result.emails === 1 ? '' : 's'}.
            {result.unknownRefs.length > 0 && (
              <div className="sm" style={{ marginTop: 6 }}>
                Not found in this database:{' '}
                <span className="mono">{result.unknownRefs.join(', ')}</span>
              </div>
            )}
            {result.submissions === 0 && result.unknownRefs.length === 0 && (
              <div className="sm" style={{ marginTop: 6 }}>
                Those records already read that way — nothing needed changing.
              </div>
            )}
          </div>
        )}
      </div>
      <div className="ft">
        <button
          className="btn"
          disabled={run.isPending}
          onClick={() => { setError(null); setResult(null); run.mutate(true); }}
        >
          Clear the marking
        </button>
        <button
          className="btn primary"
          disabled={run.isPending}
          onClick={() => { setError(null); setResult(null); run.mutate(false); }}
        >
          {run.isPending
            ? 'Working…'
            : custom ? 'Mark these records' : 'Mark the demo records'}
        </button>
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
