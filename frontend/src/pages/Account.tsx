import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { api, ApiError } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/format';
import type { Profile } from '../lib/types';
import { Avatar } from '../shell/Avatar';
import { Page, ROLE_LABEL } from '../shell/Shell';

/**
 * The departments the console knows about, mirroring the admin form. A select
 * rather than free text so the Reports grouping stays meaningful — a department
 * typed three ways is three departments as far as any roll-up is concerned.
 */
const DEPARTMENTS = [
  'Sales', 'Accounting', 'Marketing', 'Production', 'Media', 'International', 'Administration',
];

/** The palette accounts are seeded from (backend/src/auth/auth.service.ts). */
const COLOURS = ['#0E0E11', '#2F6BFF', '#0C7A4D', '#6B4BC4', '#A96C05', '#B3332A'];

/** What the avatar upload accepts, mirroring AVATAR_CONTENT_TYPES on the server. */
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export function Account() {
  const { user } = useAuth();
  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get<Profile>('/api/profile'),
  });

  if (!user) return null;

  return (
    <Page crumb="Console" title="Account">
      <div className="grid" style={{ maxWidth: 760 }}>
        {profile ? <ProfileCard profile={profile} /> : <div className="card"><div className="bd mut">Loading…</div></div>}
        <PasswordCard />
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function ProfileCard({ profile }: { profile: Profile }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState({
    name: profile.name,
    phone: profile.phone ?? '',
    department: profile.department ?? '',
    title: profile.title ?? '',
    colour: profile.colour ?? '#0E0E11',
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Re-seed the form when the server's copy changes underneath it — an avatar
  // upload returns a whole fresh profile, and without this the fields would snap
  // back to whatever they held when the card first mounted.
  useEffect(() => {
    setForm({
      name: profile.name,
      phone: profile.phone ?? '',
      department: profile.department ?? '',
      title: profile.title ?? '',
      colour: profile.colour ?? '#0E0E11',
    });
  }, [profile]);

  /** Land a fresh profile in both caches: this screen's, and the shell's session. */
  function land(next: Profile) {
    qc.setQueryData(['profile'], next);
    void qc.invalidateQueries({ queryKey: ['me'] });
  }

  const save = useMutation({
    mutationFn: () =>
      api.patch<Profile>('/api/profile', {
        name: form.name.trim(),
        // Empty means "I don't have one", which the API takes as null. Sending
        // "" would store a field that reads as present and blank.
        phone: form.phone.trim() || null,
        department: form.department || null,
        title: form.title.trim() || null,
        colour: form.colour,
      }),
    onSuccess: (next) => {
      land(next);
      setError(null);
      setSaved(true);
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save'),
  });

  const removeAvatar = useMutation({
    mutationFn: () => api.del<Profile>('/api/profile/avatar'),
    onSuccess: land,
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not remove the picture'),
  });

  /**
   * Presign, PUT to R2, then commit — the same three steps a submission document
   * takes, for the same reason: the image never passes through our API.
   */
  async function upload(file: File) {
    setError(null);
    if (file.size > MAX_AVATAR_BYTES) {
      setError('That image is over 5 MB. Please pick a smaller one.');
      return;
    }

    setUploading(true);
    try {
      const presigned = await api.post<{
        uploadUrl: string;
        storageKey: string;
        headers: Record<string, string>;
      }>('/api/profile/avatar/presign', {
        filename: file.name,
        contentType: file.type,
        size: file.size,
      });

      const put = await fetch(presigned.uploadUrl, {
        method: 'PUT',
        headers: presigned.headers,
        body: file,
      });
      if (!put.ok) throw new Error(`Upload to storage failed (${put.status})`);

      land(await api.put<Profile>('/api/profile/avatar', { storageKey: presigned.storageKey }));
    } catch (e) {
      // A 503 here means object storage was never configured, which is an
      // operator problem and not something the user can act on — say so plainly
      // rather than showing them a raw storage error.
      const unconfigured = e instanceof ApiError && e.status === 503;
      setError(
        unconfigured
          ? 'Picture uploads are not available — ask an administrator to configure storage.'
          : e instanceof Error
            ? e.message
            : 'Upload failed',
      );
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const dirty =
    form.name.trim() !== profile.name ||
    (form.phone.trim() || null) !== (profile.phone ?? null) ||
    (form.department || null) !== (profile.department ?? null) ||
    (form.title.trim() || null) !== (profile.title ?? null) ||
    form.colour !== (profile.colour ?? '#0E0E11');

  const set = (k: keyof typeof form) => (v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };

  return (
    <div className="card">
      <div className="hd">
        <h3>Profile</h3>
        <div className="sp" style={{ flex: 1 }} />
        {saved && !dirty && <span className="sm mut">Saved</span>}
      </div>
      <div className="bd">
        <div className="rowflex" style={{ gap: 16, marginBottom: 20, alignItems: 'center' }}>
          <Avatar name={profile.name} colour={form.colour} src={profile.avatarUrl} size={64} />
          <div style={{ minWidth: 0 }}>
            <div className="b" style={{ fontSize: 16 }}>{profile.name}</div>
            <div className="mut sm">{ROLE_LABEL[profile.role]}</div>
            <div className="rowflex" style={{ gap: 8, marginTop: 8 }}>
              <button
                className="btn sm"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                {uploading ? 'Uploading…' : profile.hasAvatar ? 'Change picture' : 'Upload picture'}
              </button>
              {profile.hasAvatar && (
                <button
                  className="btn sm"
                  disabled={removeAvatar.isPending}
                  onClick={() => removeAvatar.mutate()}
                >
                  Remove
                </button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </div>
        </div>

        <div className="f" style={{ marginBottom: 16 }}>
          <label>Avatar colour</label>
          <div className="help" style={{ marginBottom: 8 }}>
            Used wherever you appear without a picture.
          </div>
          <div className="colour-choices">
            {COLOURS.map((c) => (
              <button
                key={c}
                type="button"
                className={'colour-choice' + (form.colour === c ? ' on' : '')}
                style={{ background: c }}
                aria-label={`Use ${c}`}
                aria-pressed={form.colour === c}
                onClick={() => set('colour')(c)}
              />
            ))}
          </div>
        </div>

        <div className="fields">
          <div className="f">
            <label>Full name</label>
            <input value={form.name} onChange={(e) => set('name')(e.target.value)} maxLength={120} />
          </div>
          <div className="f">
            <label>Job title</label>
            <input
              value={form.title}
              onChange={(e) => set('title')(e.target.value)}
              maxLength={80}
              placeholder="e.g. Senior Sales Representative"
            />
          </div>
          <div className="f">
            <label>Phone</label>
            <input value={form.phone} onChange={(e) => set('phone')(e.target.value)} maxLength={40} />
          </div>
          <div className="f">
            <label>Department</label>
            <select value={form.department} onChange={(e) => set('department')(e.target.value)}>
              <option value="">—</option>
              {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </div>

        {error && <div className="errbox" style={{ marginTop: 12 }}>{error}</div>}

        <div className="rowflex" style={{ gap: 8, marginTop: 16 }}>
          <button
            className="btn primary"
            disabled={!dirty || !form.name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
          {dirty && (
            <button
              className="btn"
              onClick={() => {
                setForm({
                  name: profile.name,
                  phone: profile.phone ?? '',
                  department: profile.department ?? '',
                  title: profile.title ?? '',
                  colour: profile.colour ?? '#0E0E11',
                });
                setError(null);
              }}
            >
              Discard
            </button>
          )}
        </div>

        <div className="sect" style={{ marginTop: 22 }}>
          <div className="hd"><h3>Managed by your administrator</h3></div>
        </div>
        <div className="fields">
          <ReadOnly label="Work email" value={profile.email} />
          <ReadOnly label="Role" value={ROLE_LABEL[profile.role]} />
          <ReadOnly label="Employee ID" value={profile.employeeId ?? '—'} />
          <ReadOnly label="Joined" value={fmtDate(profile.createdAt)} />
          <ReadOnly
            label="Last sign-in"
            value={profile.lastLoginAt ? fmtDateTime(profile.lastLoginAt) : 'Never'}
          />
        </div>
        <div className="note" style={{ marginTop: 12 }}>
          Your email address is how you sign in and where security codes are sent, so it is
          changed by an administrator rather than here. Your role is a permission grant and
          is theirs to give.
        </div>
      </div>
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="f">
      <label>{label}</label>
      <input value={value} readOnly />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

function PasswordCard() {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () =>
      api.post('/api/profile/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setCurrent(''); setNext(''); setConfirm('');
      setError(null);
      setDone(true);
    },
    onError: (e) => {
      setDone(false);
      setError(e instanceof Error ? e.message : 'Could not change your password');
    },
  });

  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length >= 8 && next === confirm;

  return (
    <div className="card">
      <div className="hd"><h3>Password</h3></div>
      <div className="bd">
        <div className="mut sm" style={{ marginBottom: 12 }}>
          Signed in as {user?.email}.
        </div>

        <div className="fields">
          <div className="f">
            <label>Current password</label>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => { setCurrent(e.target.value); setDone(false); }}
            />
          </div>
          <div className="f">
            <label>New password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => { setNext(e.target.value); setDone(false); }}
            />
            <div className="help">At least 8 characters.</div>
          </div>
          <div className={'f' + (mismatch ? ' err' : '')}>
            <label>Confirm new password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setDone(false); }}
            />
            {mismatch && <div className="msg">Those do not match.</div>}
          </div>
        </div>

        {error && <div className="errbox" style={{ marginTop: 12 }}>{error}</div>}
        {done && (
          <div className="note" style={{ marginTop: 12 }}>
            Password changed. You are still signed in here — every other device has been
            signed out.
          </div>
        )}

        <button
          className="btn primary"
          style={{ marginTop: 16 }}
          disabled={!ready || change.isPending}
          onClick={() => change.mutate()}
        >
          {change.isPending ? 'Changing…' : 'Change password'}
        </button>
      </div>
    </div>
  );
}
