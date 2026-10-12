import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import { useRoles } from '../lib/roles';
import type { PermissionInfo, RoleRow } from '../lib/types';

/**
 * Administration -> Roles. Create a role, rename it, choose what it can do,
 * delete it. The five built-in roles can be renamed and re-permissioned but not
 * deleted; Administrator always keeps every permission so nobody is locked out.
 * A change takes effect for everyone holding the role on their next request.
 */
export function RolesTab() {
  const qc = useQueryClient();
  const { roles, permissions } = useRoles();
  const [editing, setEditing] = useState<RoleRow | 'new' | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['roles'] });
    // The signed-in user's own permissions may have just changed.
    void qc.invalidateQueries({ queryKey: ['me'] });
  };

  return (
    <>
      <div className="card">
        <div className="hd">
          <h3>Roles</h3>
          <div className="sp" />
          <button className="btn sm blue" onClick={() => setEditing('new')}>+ New role</button>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Role</th><th>Type</th><th className="num">Accounts</th>
                <th className="num">Permissions</th><th />
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.key}>
                  <td>
                    <div className="b">{r.label}</div>
                    <div className="mut sm mono">{r.key}</div>
                  </td>
                  <td className="sm">{r.locked ? 'Built-in · full access' : r.builtIn ? 'Built-in' : 'Custom'}</td>
                  <td className="num">{r.users}</td>
                  <td className="num">{r.permissions.length} / {permissions.length}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn sm" onClick={() => setEditing(r)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="note" style={{ marginTop: 16 }}>
        A role&rsquo;s permissions decide which screens and actions its accounts get. Changes apply
        to everyone holding the role straight away. Built-in roles can be renamed and edited but
        not deleted; a custom role can be deleted once no account or open invitation uses it.
      </div>

      {editing && (
        <RoleModal
          role={editing === 'new' ? null : editing}
          permissions={permissions}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </>
  );
}

function RoleModal({
  role, permissions, onClose, onSaved,
}: {
  role: RoleRow | null;
  permissions: PermissionInfo[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { user } = useAuth();
  const [label, setLabel] = useState(role?.label ?? '');
  const [granted, setGranted] = useState<Set<string>>(() => new Set(role?.permissions ?? []));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = role?.locked ?? false;
  const groups = useMemo(() => {
    const by = new Map<string, PermissionInfo[]>();
    for (const p of permissions) by.set(p.group, [...(by.get(p.group) ?? []), p]);
    return [...by.entries()];
  }, [permissions]);

  const save = useMutation({
    mutationFn: () => {
      const body = { label: label.trim(), permissions: [...granted] };
      return role ? api.patch(`/api/roles/${role.key}`, body) : api.post('/api/roles', body);
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/api/roles/${role!.key}`),
    onSuccess: onSaved,
    onError: (e: Error) => { setConfirmDelete(false); setError(e.message); },
  });

  function toggle(key: string, on: boolean) {
    setGranted((prev) => {
      const next = new Set(prev);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }

  const ownRole = role?.key === user?.role;
  const ready = label.trim() !== '';

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="hd">
          <h3>{role ? `Edit role — ${role.label}` : 'New role'}</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>

        <div className="bd">
          <div className="fields">
            <div className="f wide">
              <label>Name</label>
              <input
                value={label}
                maxLength={40}
                placeholder="e.g. Field Representative"
                onChange={(e) => setLabel(e.target.value)}
              />
              {role && <div className="help">Key <span className="mono">{role.key}</span> — fixed; only the name changes.</div>}
            </div>
          </div>

          {locked ? (
            <div className="note" style={{ marginTop: 12 }}>
              Administrator always has every permission, so there is always someone who can manage
              roles and accounts. Only its name can be changed.
            </div>
          ) : (
            <>
              <div className="rowflex" style={{ gap: 8, margin: '12px 0 4px' }}>
                <b className="sm">Permissions</b>
                <div className="sp" style={{ flex: 1 }} />
                <button type="button" className="btn sm" onClick={() => setGranted(new Set(permissions.map((p) => p.key)))}>
                  Select all
                </button>
                <button type="button" className="btn sm" onClick={() => setGranted(new Set())}>
                  Clear
                </button>
              </div>
              {groups.map(([group, perms]) => (
                <div key={group} style={{ marginTop: 10 }}>
                  <div className="mut sm" style={{ marginBottom: 6 }}>{group}</div>
                  <div className="checks">
                    {perms.map((p) => (
                      <label key={p.key} className={'chk' + (granted.has(p.key) ? ' on' : '')}>
                        <input
                          type="checkbox"
                          checked={granted.has(p.key)}
                          onChange={(e) => toggle(p.key, e.target.checked)}
                        />
                        <span className="t">{p.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
              {ownRole && !granted.has('admin.manage') && (
                <div className="note warn" style={{ marginTop: 12 }}>
                  This is your own role — it must keep Administration, or you would lose access to
                  this screen.
                </div>
              )}
            </>
          )}

          {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        </div>

        <div className="ft">
          {confirmDelete ? (
            <>
              <span className="sm mut" style={{ marginRight: 'auto' }}>Delete the {role?.label} role?</span>
              <button className="btn" disabled={remove.isPending} onClick={() => setConfirmDelete(false)}>Keep</button>
              <button className="btn dgr" disabled={remove.isPending} onClick={() => remove.mutate()}>
                {remove.isPending ? 'Deleting…' : 'Yes, delete'}
              </button>
            </>
          ) : (
            <>
              {role && !role.builtIn && (
                <button className="btn dgr" style={{ marginRight: 'auto' }} onClick={() => setConfirmDelete(true)}>
                  Delete role
                </button>
              )}
              <button className="btn" onClick={onClose}>Cancel</button>
              <button
                className="btn primary"
                disabled={!ready || save.isPending}
                onClick={() => { setError(null); save.mutate(); }}
              >
                {save.isPending ? 'Saving…' : role ? 'Save role' : 'Add role'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
