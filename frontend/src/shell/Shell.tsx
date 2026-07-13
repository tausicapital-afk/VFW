import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { can, type Permission } from '../lib/acl';
import { api } from '../lib/api';
import type { Role, Submission, User } from '../lib/types';

const ROLE_LABEL: Record<Role, string> = {
  SALES: 'Sales Representative',
  INTERN: 'Intern',
  ACCT: 'Accounting',
  MGR: 'Sales Manager',
  ADMIN: 'Administrator',
};

// Mirrors NAV in vfw-console.html (line 1333). Only the routes in the current
// slice are enabled; the rest land as they are built.
type NavItem =
  | { grp: string }
  | { to: string; label: string; ic: string; roles: Role[]; badge?: 'queue' };

const NAV: NavItem[] = [
  { grp: 'Work' },
  { to: '/', label: 'Dashboard', ic: '◧', roles: ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'] },
  { to: '/new', label: 'New submission', ic: '+', roles: ['SALES', 'INTERN', 'ADMIN'] },
  { to: '/submissions', label: 'Submissions', ic: '▤', roles: ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'] },
  { to: '/contacts', label: 'Contacts', ic: '◈', roles: ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'] },
  { to: '/queue', label: 'Approval queue', ic: '⚑', roles: ['ACCT', 'ADMIN'], badge: 'queue' },
  { to: '/qbo', label: 'QuickBooks', ic: '⇪', roles: ['ACCT', 'ADMIN'] },
  { grp: 'People' },
  { to: '/board', label: 'Leaderboard', ic: '★', roles: ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'] },
  { to: '/feedback', label: 'Designer feedback', ic: '☆', roles: ['ACCT', 'MGR', 'ADMIN'] },
  { to: '/internal', label: 'Internal notes', ic: '✎', roles: ['ACCT', 'MGR', 'ADMIN'] },
  { grp: 'Insight' },
  { to: '/reports', label: 'Reports', ic: '▦', roles: ['ACCT', 'MGR', 'ADMIN'] },
  { to: '/audit', label: 'Audit trail', ic: '◷', roles: ['ACCT', 'MGR', 'ADMIN'] },
  { grp: 'System' },
  { to: '/admin', label: 'Administration', ic: '⚙', roles: ['ADMIN'] },
];

function Avatar({ user }: { user: User }) {
  const initials = user.name.split(' ').map((p) => p[0]).slice(0, 2).join('');
  return (
    <div className="av" style={{ background: user.colour ?? '#0E0E11' }}>
      {initials}
    </div>
  );
}

export function Shell() {
  const { user, logout } = useAuth();
  const location = useLocation();

  // Only Accounting/Admin can read the queue, so only they may ask for its
  // depth — otherwise this fires a request that is guaranteed to 403.
  const showQueue = can('submission.approve', user?.role);
  const { data: queue } = useQuery({
    queryKey: ['queue'],
    queryFn: () => api.get<Submission[]>('/api/submissions/queue'),
    enabled: showQueue,
  });

  if (!user) return null;

  const pending = queue?.filter((s) => s.status === 'PENDING').length ?? 0;

  return (
    // .on is what makes #app visible and lays out the rail + main grid.
    <div id="app" className="on">
      <aside className="rail">
        <div className="brand">
          <div className="mk">VFW</div>
          <b>Console</b>
        </div>

        <div id="nav">
          {NAV.map((item, i) => {
            if ('grp' in item) {
              // Drop the heading when the role can see nothing under it —
              // otherwise a sales rep gets a bare "Insight" label with no links.
              const until = NAV.slice(i + 1).findIndex((n) => 'grp' in n);
              const members = NAV.slice(i + 1, until === -1 ? undefined : i + 1 + until);
              const visible = members.some(
                (n) => !('grp' in n) && n.roles.includes(user.role),
              );
              return visible ? <div className="grp" key={`g${i}`}>{item.grp}</div> : null;
            }
            if (!item.roles.includes(user.role)) return null;
            const badge = item.badge === 'queue' ? pending : 0;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => 'nav' + (isActive ? ' on' : '')}
              >
                <span className="ic">{item.ic}</span>
                {item.label}
                {badge > 0 && <span className="badge">{badge}</span>}
              </NavLink>
            );
          })}
        </div>

        <div className="who">
          <div className="row">
            <Avatar user={user} />
            <div>
              <div className="nm">{user.name}</div>
              <div className="rl">{ROLE_LABEL[user.role]}</div>
            </div>
          </div>
          <button className="nav" onClick={() => void logout()}>
            <span className="ic">→</span> Sign out
          </button>
        </div>
      </aside>

      <div className="main">
        <Outlet key={location.pathname} />
      </div>
    </div>
  );
}

/** The topbar every page renders, so crumb/title stay consistent. */
export function Page({
  crumb, title, actions, children,
}: {
  crumb: string;
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="topbar">
        <div>
          <span className="crumb">{crumb}</span>
          <h1>{title}</h1>
        </div>
        <div className="sp" />
        <div className="rowflex">{actions}</div>
      </header>
      <div className="wrap">{children}</div>
    </>
  );
}

export function Guard({ permission, children }: { permission: Permission; children: React.ReactNode }) {
  const { user } = useAuth();
  if (!can(permission, user?.role)) {
    return (
      <Page crumb="Console" title="Restricted">
        <div className="empty">
          <h3>Not available to your role</h3>
          <p>Your account does not have permission to view this.</p>
        </div>
      </Page>
    );
  }
  return <>{children}</>;
}
