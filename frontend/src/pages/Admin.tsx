import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { fmtDate, money } from '../lib/format';
import type {
  AdminCatalogue, AdminUser, Currency, Invitation, Role, Settings,
} from '../lib/types';
import { Page } from '../shell/Shell';

const ROLE_LABEL: Record<Role, string> = {
  SALES: 'Sales Representative',
  INTERN: 'Intern',
  ACCT: 'Accounting',
  MGR: 'Sales Manager',
  ADMIN: 'Administrator',
};

const DEPARTMENTS = [
  'Sales', 'Accounting', 'Marketing', 'Production', 'Media', 'International', 'Administration',
];

// The mockup maps role and status onto the status-pill palette rather than
// inventing a second one (line 2947). Same here — .pill.{STATUS} already exists.
const ROLE_PILL: Record<Role, string> = {
  ADMIN: 'EXPORTED', ACCT: 'APPROVED', MGR: 'PENDING', INTERN: 'RETURNED', SALES: 'DRAFT',
};
const USER_PILL: Record<string, string> = {
  ACTIVE: 'APPROVED', PENDING: 'PENDING', REJECTED: 'REJECTED', DISABLED: 'RETURNED',
};
const INVITE_PILL: Record<string, string> = {
  ACTIVE: 'APPROVED', USED: 'EXPORTED', REVOKED: 'REJECTED', EXPIRED: 'RETURNED',
};

const TABS = [
  ['invites', 'Invitations & approvals'],
  ['users', 'Users & roles'],
  ['packages', 'Packages & pricing'],
  ['tax', 'Tax rates'],
  ['settings', 'Settings'],
] as const;

type TabKey = (typeof TABS)[number][0];

export function Admin() {
  const [tab, setTab] = useState<TabKey>('invites');

  return (
    <Page crumb="System" title="Administration">
      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            className={'tab' + (tab === key ? ' on' : '')}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'invites' && <InvitesTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'packages' && <PackagesTab />}
      {tab === 'tax' && <TaxTab />}
      {tab === 'settings' && <SettingsTab />}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Invitations & pending approvals
// ---------------------------------------------------------------------------

function InvitesTab() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<Invitation | null>(null);

  const { data: invites } = useQuery({
    queryKey: ['invitations'],
    queryFn: () => api.get<{ invitations: Invitation[] }>('/api/invitations'),
  });
  const { data: pending } = useQuery({
    queryKey: ['users', 'pending'],
    queryFn: () => api.get<{ users: AdminUser[] }>('/api/users/pending'),
  });

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['invitations'] });
    void qc.invalidateQueries({ queryKey: ['users'] });
  }

  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/api/users/${id}/approve`),
    onSuccess: refresh,
  });
  const reject = useMutation({
    mutationFn: (id: string) => api.post(`/api/users/${id}/reject`),
    onSuccess: refresh,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/invitations/${id}/revoke`),
    onSuccess: refresh,
  });

  const rows = pending?.users ?? [];
  const list = invites?.invitations ?? [];

  return (
    <div className="split">
      <div className="grid">
        <div className="card">
          <div className="hd">
            <h3>Pending approval</h3>
            <div className="sp" />
            <span className="pill PENDING">{rows.length}</span>
          </div>
          <div className="tbl-wrap">
            {!rows.length ? (
              <div className="empty">
                <h3>Nothing waiting</h3>
                <p>New sign-ups appear here for review before they can sign in.</p>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th><th>Email</th><th>Role</th><th>Department</th>
                    <th>Requested</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id}>
                      <td className="b">{u.name}</td>
                      <td className="sm">{u.email}</td>
                      <td className="sm">{ROLE_LABEL[u.role]}</td>
                      <td className="sm">{u.department ?? '—'}</td>
                      <td className="sm mut">{fmtDate(u.createdAt)}</td>
                      <td>
                        <div className="rowflex">
                          <button
                            className="btn sm ok"
                            disabled={approve.isPending}
                            onClick={() => approve.mutate(u.id)}
                          >
                            Approve
                          </button>
                          <button
                            className="btn sm dgr"
                            disabled={reject.isPending}
                            onClick={() => reject.mutate(u.id)}
                          >
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="hd">
            <h3>Invitations</h3>
            <div className="sp" />
            <button className="btn sm blue" onClick={() => setOpen(true)}>+ New invitation</button>
          </div>
          <div className="tbl-wrap">
            {!list.length ? (
              <div className="empty">
                <h3>No invitations yet</h3>
                <p>Signup is invite-only. Generate a code to let someone in.</p>
              </div>
            ) : (
              <table>
                <thead>
                  <tr><th>Code</th><th>Role</th><th>Email</th><th>Status</th><th>Expires</th><th /></tr>
                </thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.id}>
                      <td className="mono sm b">{i.code}</td>
                      <td className="sm">{ROLE_LABEL[i.role]}</td>
                      <td className="sm">{i.email ?? 'Open code'}</td>
                      <td><span className={'pill ' + INVITE_PILL[i.status]}>{i.status}</span></td>
                      <td className="sm mut">{fmtDate(i.expiresAt)}</td>
                      <td>
                        {i.status === 'ACTIVE' && (
                          <button
                            className="btn sm dgr"
                            disabled={revoke.isPending}
                            onClick={() => revoke.mutate(i.id)}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {open && (
        <InviteModal
          onClose={() => setOpen(false)}
          onDone={(inv) => { setOpen(false); setIssued(inv); refresh(); }}
        />
      )}
      {issued && <IssuedModal invitation={issued} onClose={() => setIssued(null)} />}
    </div>
  );
}

function InviteModal({ onClose, onDone }: { onClose: () => void; onDone: (i: Invitation) => void }) {
  const [role, setRole] = useState<Role>('SALES');
  const [department, setDepartment] = useState('Sales');
  const [email, setEmail] = useState('');
  const [expiresInDays, setDays] = useState(14);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<Invitation>('/api/invitations', {
        role,
        department,
        email: email.trim() || undefined,
        expiresInDays,
      }),
    onSuccess: onDone,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>New invitation</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="bd">
          <div className="fields">
            <div className="f">
              <label>Role</label>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
                  <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                ))}
              </select>
              <div className="help">The account is created with this role — the signup form cannot override it.</div>
            </div>
            <div className="f">
              <label>Department</label>
              <select value={department} onChange={(e) => setDepartment(e.target.value)}>
                {DEPARTMENTS.map((d) => <option key={d}>{d}</option>)}
              </select>
            </div>
            <div className="f wide">
              <label>Email (optional — leave blank for an open code)</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
              />
            </div>
            <div className="f">
              <label>Expires in (days)</label>
              <input
                type="number"
                value={expiresInDays}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </div>
          </div>
          {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        </div>
        <div className="ft">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={create.isPending}
            onClick={() => { setError(null); create.mutate(); }}
          >
            {create.isPending ? 'Generating…' : 'Generate invitation'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The code has to reach a human. If the server could not email it — no transport
 * configured, or an open code with no address — say so plainly and show the code
 * to copy, rather than implying a message went out that did not.
 */
function IssuedModal({ invitation, onClose }: { invitation: Invitation; onClose: () => void }) {
  const link = `${window.location.origin}/signup/${invitation.code}`;

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>Invitation {invitation.code}</h3>
          <div className="sp" style={{ flex: 1 }} />
        </div>
        <div className="bd">
          {invitation.emailed ? (
            <div className="note good">Emailed to {invitation.email}.</div>
          ) : (
            <div className="note warn">
              <b>Not emailed.</b>{' '}
              {invitation.emailError ?? 'No address was given — this is an open code.'} Send the
              link below to them yourself.
            </div>
          )}
          <div className="totals" style={{ marginTop: 12 }}>
            <div className="r"><span>Code</span><span className="b">{invitation.code}</span></div>
            <div className="r"><span>Role</span><span>{ROLE_LABEL[invitation.role]}</span></div>
            <div className="r"><span>Expires</span><span>{fmtDate(invitation.expiresAt)}</span></div>
            <div className="r"><span>Signup link</span><span className="sm">{link}</span></div>
          </div>
        </div>
        <div className="ft">
          <button className="btn" onClick={() => void navigator.clipboard?.writeText(link)}>
            Copy link
          </button>
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function UsersTab() {
  const { data } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ users: AdminUser[] }>('/api/users'),
  });
  const users = data?.users ?? [];

  return (
    <div className="card">
      <div className="hd"><h3>Users</h3></div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Email</th><th>Role</th><th>Department</th>
              <th className="num">Commission %</th><th className="num">Target</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="b">{u.name}</td>
                <td className="sm">{u.email}</td>
                <td><span className={'pill ' + ROLE_PILL[u.role]}>{ROLE_LABEL[u.role]}</span></td>
                <td className="sm">{u.department ?? '—'}</td>
                <td className="num">{u.commissionPct}</td>
                <td className="num">{money(u.target, 'CAD')}</td>
                <td><span className={'pill ' + USER_PILL[u.status]}>{u.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Catalogue — packages, add-ons, tax
// ---------------------------------------------------------------------------

function useCatalogue() {
  return useQuery({
    queryKey: ['admin', 'catalogue'],
    queryFn: () => api.get<AdminCatalogue>('/api/admin/catalogue'),
  });
}

function PackagesTab() {
  const qc = useQueryClient();
  const { data } = useCatalogue();
  const [editing, setEditing] = useState<string | null>(null);

  const pkg = data?.packages.find((p) => p.id === editing);

  return (
    <>
      <div className="note" style={{ marginBottom: 16 }}>
        Editing a price changes what reps can sell <b>from now on</b>. It never rewrites a
        submission that has already been priced — every sale copies its prices onto the record
        at submission time.
      </div>

      <div className="card">
        <div className="hd"><h3>Package rate card</h3></div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Brand</th><th>Package</th><th className="num">Looks</th>
                <th>City pricing</th><th>Tax</th><th>GL</th><th />
              </tr>
            </thead>
            <tbody>
              {data?.packages.map((p) => (
                <tr key={p.id}>
                  <td><span className={'tag ' + p.brand}>{p.brand}</span></td>
                  <td className="b">{p.name}</td>
                  <td className="num">{p.looks}</td>
                  <td className="sm mono">
                    {p.prices.map((pr) => (
                      <div key={pr.id}>
                        {pr.city.name} {money(pr.price, pr.currency)}
                      </div>
                    ))}
                  </td>
                  <td className="sm">{p.taxCode}</td>
                  <td className="mono sm">{p.glCode}</td>
                  <td>
                    <button className="btn sm" onClick={() => setEditing(p.id)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="hd"><h3>Add-on catalogue</h3></div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Brand</th><th>Add-on</th><th className="num">Price</th>
                <th>GL</th><th>Note</th><th />
              </tr>
            </thead>
            <tbody>
              {data?.addons.map((a) => (
                <AddonRowEdit
                  key={a.id}
                  addon={a}
                  onSaved={() => void qc.invalidateQueries({ queryKey: ['admin', 'catalogue'] })}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {pkg && (
        <PackageModal
          pkg={pkg}
          taxes={data?.taxes ?? []}
          glAccounts={data?.glAccounts ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ['admin', 'catalogue'] });
          }}
        />
      )}
    </>
  );
}

function AddonRowEdit({
  addon, onSaved,
}: {
  addon: AdminCatalogue['addons'][number];
  onSaved: () => void;
}) {
  const [price, setPrice] = useState(addon.price);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    // Money leaves as the string it arrived as. Nothing here parses it into a
    // Number first — that is how a cent goes missing.
    mutationFn: () => api.patch(`/api/admin/addons/${addon.id}`, { price }),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  const dirty = price !== addon.price;

  return (
    <tr>
      <td><span className={'tag ' + addon.brand}>{addon.brand}</span></td>
      <td className="b">{addon.name}</td>
      <td className="num">
        <input
          type="number"
          step="0.01"
          style={{ width: 110, textAlign: 'right' }}
          value={price}
          onChange={(e) => setPrice(e.target.value)}
        />
        <div className="sm mut">{addon.currency}</div>
        {error && <div className="sm" style={{ color: 'var(--red)' }}>{error}</div>}
      </td>
      <td className="mono sm">{addon.glCode}</td>
      <td className="sm mut">{addon.note ?? '—'}</td>
      <td>
        <button
          className="btn sm"
          disabled={!dirty || save.isPending}
          onClick={() => { setError(null); save.mutate(); }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </td>
    </tr>
  );
}

function PackageModal({
  pkg, taxes, glAccounts, onClose, onSaved,
}: {
  pkg: AdminCatalogue['packages'][number];
  taxes: AdminCatalogue['taxes'];
  glAccounts: AdminCatalogue['glAccounts'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [prices, setPrices] = useState<Record<string, string>>(
    Object.fromEntries(pkg.prices.map((p) => [p.cityId, p.price])),
  );
  const [taxCode, setTaxCode] = useState(pkg.taxCode);
  const [glCode, setGlCode] = useState(pkg.glCode);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/api/admin/packages/${pkg.id}`, {
        taxCode,
        glCode,
        prices: Object.entries(prices).map(([cityId, price]) => ({ cityId, price })),
      }),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>Edit {pkg.name}</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="bd">
          <div className="fields">
            {pkg.prices.map((p) => (
              <div className="f" key={p.id}>
                <label>{p.city.name} ({p.currency})</label>
                <input
                  type="number"
                  step="0.01"
                  value={prices[p.cityId] ?? ''}
                  onChange={(e) => setPrices({ ...prices, [p.cityId]: e.target.value })}
                />
              </div>
            ))}
            <div className="f">
              <label>Tax code</label>
              <select value={taxCode} onChange={(e) => setTaxCode(e.target.value)}>
                {taxes.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
              </select>
            </div>
            <div className="f">
              <label>GL account</label>
              <select value={glCode} onChange={(e) => setGlCode(e.target.value)}>
                {glAccounts.map((g) => (
                  <option key={g.code} value={g.code}>{g.code} · {g.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="note lock" style={{ marginTop: 12 }}>
            Historical submissions keep the price they were sold at. This only changes what the
            new-submission form offers.
          </div>
          {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        </div>
        <div className="ft">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={save.isPending}
            onClick={() => { setError(null); save.mutate(); }}
          >
            {save.isPending ? 'Saving…' : 'Save rate card'}
          </button>
        </div>
      </div>
    </div>
  );
}

function TaxTab() {
  const qc = useQueryClient();
  const { data } = useCatalogue();

  return (
    <>
      <div className="card">
        <div className="hd"><h3>Tax profiles</h3></div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Code</th><th>Label</th><th className="num">Rate %</th>
                <th className="num">GST</th><th className="num">PST</th><th className="num">HST</th>
                <th>Note</th><th />
              </tr>
            </thead>
            <tbody>
              {data?.taxes.map((t) => (
                <TaxRowEdit
                  key={t.code}
                  tax={t}
                  onSaved={() => void qc.invalidateQueries({ queryKey: ['admin', 'catalogue'] })}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="note" style={{ marginTop: 16 }}>
        Changing a rate re-prices nothing that already exists. A submission carries the rate it
        was taxed at; only a deliberate tax-profile change on the submission itself re-prices it,
        and that is written to the audit trail before and after.
      </div>
    </>
  );
}

function TaxRowEdit({
  tax, onSaved,
}: {
  tax: AdminCatalogue['taxes'][number];
  onSaved: () => void;
}) {
  const [rate, setRate] = useState(tax.rate);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.patch(`/api/admin/tax/${tax.code}`, { rate }),
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  return (
    <tr>
      <td className="mono b">{tax.code}</td>
      <td>{tax.label}</td>
      <td className="num">
        <input
          type="number"
          step="0.001"
          style={{ width: 90, textAlign: 'right' }}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
        />
        {error && <div className="sm" style={{ color: 'var(--red)' }}>{error}</div>}
      </td>
      <td className="num">{tax.gst}</td>
      <td className="num">{tax.pst}</td>
      <td className="num">{tax.hst}</td>
      <td className="sm mut">{tax.note ?? '—'}</td>
      <td>
        <button
          className="btn sm"
          disabled={rate === tax.rate || save.isPending}
          onClick={() => { setError(null); save.mutate(); }}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Settings — FX rates, score weights, discount threshold
// ---------------------------------------------------------------------------

const CURRENCIES: Currency[] = ['USD', 'GBP', 'EUR', 'JPY'];

function SettingsTab() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<Settings>('/api/admin/settings'),
  });

  if (!data) return <div className="empty"><h3>Loading…</h3></div>;
  return <SettingsForm settings={data} onSaved={() => {
    void qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
    void qc.invalidateQueries({ queryKey: ['leaderboard'] });
    void qc.invalidateQueries({ queryKey: ['reports'] });
  }} />;
}

function SettingsForm({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [discount, setDiscount] = useState(settings.discountApprovalPct);
  const [fx, setFx] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(settings.fxRates).map(([k, v]) => [k, String(v)])),
  );
  const [weights, setWeights] = useState(settings.scoreWeights);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const total = weights.revenue + weights.approved + weights.collection + weights.retention;

  const save = useMutation({
    mutationFn: () =>
      api.patch('/api/admin/settings', {
        discountApprovalPct: discount,
        fxRates: Object.fromEntries(
          Object.entries(fx).map(([k, v]) => [k, Number(v)]),
        ),
        scoreWeights: weights,
      }),
    onSuccess: () => { setSaved(true); onSaved(); },
    onError: (e: Error) => { setSaved(false); setError(e.message); },
  });

  return (
    <div className="split">
      <div className="grid">
        <div className="card">
          <div className="hd"><h3>Accounting</h3></div>
          <div className="bd">
            <div className="fields">
              <div className="f">
                <label>Discount approval threshold %</label>
                <input value={discount} onChange={(e) => setDiscount(e.target.value)} />
                <div className="help">Above this, a discount needs explicit accounting sign-off.</div>
              </div>
              <div className="f">
                <label>Invoice prefix</label>
                <input value={settings.invoicePrefix} readOnly />
              </div>
              <div className="f">
                <label>Next invoice number</label>
                <input value={settings.nextInvoiceSeq} readOnly />
                <div className="help">Allocated in a transaction — not editable by hand.</div>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="hd">
            <h3>FX rates to CAD</h3>
            <div className="sp" />
            <span className="sm mut">The reporting currency</span>
          </div>
          <div className="bd">
            <div className="fields">
              {CURRENCIES.map((c) => (
                <div className="f" key={c}>
                  <label>1 {c} =</label>
                  <input
                    type="number"
                    step="0.0001"
                    value={fx[c] ?? ''}
                    onChange={(e) => setFx({ ...fx, [c]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <div className="note" style={{ marginTop: 12 }}>
              Every consolidated figure in Reports converts through these before it is summed.
              CAD is fixed at 1 — it is what everything else is expressed in.
            </div>
          </div>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <div className="hd">
            <h3>Performance score weights</h3>
            <div className="sp" />
            <span className={'pill ' + (total === 100 ? 'APPROVED' : 'REJECTED')}>{total} / 100</span>
          </div>
          <div className="bd">
            <div className="fields">
              {([
                ['revenue', 'Revenue generated'],
                ['approved', 'Approved sales'],
                ['collection', 'Payment collection'],
                ['retention', 'Customer retention'],
              ] as const).map(([key, label]) => (
                <div className="f" key={key}>
                  <label>{label}</label>
                  <input
                    type="number"
                    value={weights[key]}
                    onChange={(e) => setWeights({ ...weights, [key]: Number(e.target.value) })}
                  />
                </div>
              ))}
            </div>
            <div className="note lock" style={{ marginTop: 12 }}>
              Designer feedback and internal department comments are deliberately absent from this
              list. They are coaching signals, not compensation inputs, and the score has no field
              for them.
            </div>
          </div>
        </div>

        {error && <div className="note bad">{error}</div>}
        {saved && !error && <div className="note good">Saved. Reports and the leaderboard now use these.</div>}

        <div className="rowflex">
          <button
            className="btn primary"
            disabled={save.isPending}
            onClick={() => { setError(null); setSaved(false); save.mutate(); }}
          >
            {save.isPending ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>
    </div>
  );
}
