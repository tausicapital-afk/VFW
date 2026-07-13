import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import type { Contact } from '../lib/types';
import { Page } from '../shell/Shell';

const TYPES = ['Designer', 'Sponsor', 'Vendor', 'Media', 'Buyer', 'School'];

export function Contacts() {
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['contacts', q],
    // The server searches brand / designer / company; sending an empty q lists all.
    queryFn: () => api.get<Contact[]>('/api/contacts' + (q ? `?q=${encodeURIComponent(q)}` : '')),
  });

  const rows = data ?? [];
  const scope = can('submission.viewAll', user?.role)
    ? 'Every customer across all shows.'
    : 'Your own customers only.';

  return (
    <Page crumb="Work" title="Contacts">
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search brand, designer, company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && <button className="btn sm" onClick={() => setQ('')}>Clear</button>}
        <div style={{ flex: 1 }} />
        <span className="sm mut">{scope}</span>
        <button className="btn sm primary" onClick={() => setAdding(true)}>+ New contact</button>
      </div>

      <div className="card">
        {isLoading ? (
          <div className="empty"><h3>Loading…</h3></div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <h3>{q ? 'No matching contacts' : 'No contacts yet'}</h3>
            <p>
              Contacts are created automatically the first time a sale is submitted for a
              new brand, or add one directly.
            </p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Brand</th>
                  <th>Type</th>
                  <th>Designer</th>
                  <th>Email</th>
                  <th>Country</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.brand}</b></td>
                    <td className="sm">{c.type ?? 'Designer'}</td>
                    <td className="sm">{c.designer || '—'}</td>
                    <td className="sm">{c.email || '—'}</td>
                    <td className="sm">{c.country || '—'}</td>
                    <td>
                      <Link className="btn sm" to={`/contacts/${c.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && <NewContactModal onClose={() => setAdding(false)} />}
    </Page>
  );
}

function NewContactModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    type: 'Designer', brand: '', designer: '', company: '',
    email: '', phone: '', country: '',
  });
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const create = useMutation({
    mutationFn: () =>
      api.post<Contact>('/api/contacts', {
        type: form.type,
        brand: form.brand.trim(),
        designer: form.designer.trim() || undefined,
        company: form.company.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        country: form.country.trim() || undefined,
      }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      navigate(`/contacts/${c.id}`);
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>New contact</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>

        <div className="bd">
          <div className="fields">
            <div className="f">
              <label>Type</label>
              <select value={form.type} onChange={set('type')}>
                {TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="f">
              <label>Brand <span className="req">*</span></label>
              <input value={form.brand} onChange={set('brand')} />
            </div>
            <div className="f">
              <label>Designer / contact person</label>
              <input value={form.designer} onChange={set('designer')} />
            </div>
            <div className="f">
              <label>Company</label>
              <input value={form.company} onChange={set('company')} />
            </div>
            <div className="f">
              <label>Email</label>
              <input type="email" value={form.email} onChange={set('email')} />
            </div>
            <div className="f">
              <label>Phone</label>
              <input value={form.phone} onChange={set('phone')} />
            </div>
            <div className="f">
              <label>Country</label>
              <input value={form.country} onChange={set('country')} />
            </div>
          </div>

          {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        </div>

        <div className="ft">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={create.isPending || !form.brand.trim()}
            onClick={() => { setError(null); create.mutate(); }}
          >
            {create.isPending ? 'Creating…' : 'Create contact'}
          </button>
        </div>
      </div>
    </div>
  );
}
