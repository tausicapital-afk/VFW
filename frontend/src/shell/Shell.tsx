import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useTheme } from '../theme/ThemeContext';
import { can, type Permission } from '../lib/acl';
import { api } from '../lib/api';
import { messagingApi, qk, useMessagingRealtime, type Conversation } from '../lib/messaging';
import type { Role, Submission, User } from '../lib/types';

export const ROLE_LABEL: Record<Role, string> = {
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
  | { to: string; label: string; ic: string; roles: Role[]; badge?: 'queue' | 'messages' };

const NAV: NavItem[] = [
  { grp: 'Work' },
  { to: '/', label: 'Dashboard', ic: '◧', roles: ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'] },
  { to: '/new', label: 'New submission', ic: '+', roles: ['SALES', 'INTERN', 'ADMIN'] },
  { to: '/submissions', label: 'Submissions', ic: '▤', roles: ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'] },
  { to: '/contacts', label: 'Contacts', ic: '◈', roles: ['SALES', 'ACCT', 'MGR', 'ADMIN'] },
  { to: '/messages', label: 'Messages', ic: '✉', roles: ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'], badge: 'messages' },
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
  { to: '/logs', label: 'Logs', ic: '❈', roles: ['ADMIN'] },
];

/** The human label for a path, for the activity log line ("Opened Messages"). */
function moduleLabel(pathname: string): string {
  // Longest matching nav route wins, so /submissions/:id maps to "Submissions".
  let best: { to: string; label: string } | null = null;
  for (const item of NAV) {
    if ('grp' in item) continue;
    const match = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
    if (match && (!best || item.to.length > best.to.length)) best = item;
  }
  return best?.label ?? pathname;
}

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

  // On mobile the rail is an off-canvas drawer toggled from the top bar; on
  // desktop the CSS ignores this and the rail is always in the grid.
  const [navOpen, setNavOpen] = useState(false);
  // Any navigation (or route change) closes the drawer so it never sits open
  // over the page you just moved to.
  useEffect(() => setNavOpen(false), [location.pathname]);

  // Desktop-only: collapse the rail to an icon strip. Persisted so the choice
  // survives reloads; the mobile drawer ignores it (it's full-width there).
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('rail:collapsed') === '1',
  );
  useEffect(() => {
    localStorage.setItem('rail:collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  // Record each screen the user opens for the Logs telemetry. Fire-and-forget:
  // this is the one client-driven event, it can only ever log the caller's own
  // view, and a failure here must never surface to the user.
  //
  // Deduped by resolved module (not raw path) within a window, so paging between
  // records under one module, a re-mount, or StrictMode's double-invoke don't
  // flood the log — only genuine module transitions are recorded.
  const lastView = useRef<{ label: string; at: number } | null>(null);
  useEffect(() => {
    const label = moduleLabel(location.pathname);
    const now = Date.now();
    const prev = lastView.current;
    if (prev && prev.label === label && now - prev.at < 5 * 60_000) return;
    lastView.current = { label, at: now };
    void api
      .post('/api/activity/track', {
        action: 'MODULE_VIEW',
        module: location.pathname,
        label,
      })
      .catch(() => undefined);
  }, [location.pathname]);

  // Wire the messaging socket for the whole signed-in session: this keeps the
  // conversation cache (and the unread badge below) live from any screen, and
  // tears the socket down on sign-out.
  useMessagingRealtime();

  // Only Accounting/Admin can read the queue, so only they may ask for its
  // depth — otherwise this fires a request that is guaranteed to 403.
  const showQueue = can('submission.approve', user?.role);
  const { data: queue } = useQuery({
    queryKey: ['queue'],
    queryFn: () => api.get<Submission[]>('/api/submissions/queue'),
    enabled: showQueue,
  });

  // Everyone can message, so everyone polls their conversation list for the
  // unread badge; the socket keeps it fresh, this is just the initial load.
  const { data: conversations } = useQuery({
    queryKey: qk.conversations,
    queryFn: () => messagingApi.conversations(),
    enabled: !!user,
  });

  if (!user) return null;

  const pending = queue?.filter((s) => s.status === 'PENDING').length ?? 0;
  const unreadMessages = (conversations ?? []).reduce(
    (t: number, c: Conversation) => t + (c.unreadCount ?? 0),
    0,
  );

  return (
    // .on is what makes #app visible and lays out the rail + main grid.
    <div id="app" className={'on' + (collapsed ? ' collapsed' : '')}>
      {/* Mobile-only bar with the drawer toggle; CSS hides it on desktop. */}
      <div className="mtop">
        <button className="burger" aria-label="Menu" onClick={() => setNavOpen(true)}>☰</button>
        <div className="mk">VFW</div>
        <b>Console</b>
      </div>
      {navOpen && <button className="rail-backdrop" aria-label="Close menu" onClick={() => setNavOpen(false)} />}
      <aside className={'rail' + (navOpen ? ' open' : '')}>
        <div className="brand">
          <div className="mk">VFW</div>
          <b>Console</b>
          <button
            className="rail-collapse"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? '»' : '«'}
          </button>
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
            const badge =
              item.badge === 'queue' ? pending : item.badge === 'messages' ? unreadMessages : 0;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) => 'nav' + (isActive ? ' on' : '')}
              >
                <span className="ic">{item.ic}</span>
                <span className="lbl">{item.label}</span>
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
          <button
            className="nav"
            title={collapsed ? 'Sign out' : undefined}
            onClick={() => void logout()}
          >
            <span className="ic">→</span>
            <span className="lbl">Sign out</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <Outlet key={location.pathname} />
      </div>
    </div>
  );
}

/** Sun/moon quick toggle: flips straight between light and dark. Finer control
    (including "system") lives on the Settings screen. */
function ThemeToggle() {
  const { resolved, setTheme } = useTheme();
  const dark = resolved === 'dark';
  return (
    <button
      className="theme-toggle"
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label="Toggle dark mode"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? '☀' : '☾'}
    </button>
  );
}

/** Avatar + name in the topbar, opening a menu of Settings / Account / Logout. */
function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click-away or Escape while the menu is open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;
  const initials = user.name.split(' ').map((p) => p[0]).slice(0, 2).join('');
  const go = (to: string) => { setOpen(false); navigate(to); };

  return (
    <div className="usermenu" ref={ref}>
      <button
        className="usermenu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <div className="av" style={{ background: user.colour ?? '#0E0E11' }}>{initials}</div>
        <span className="nm">{user.name}</span>
        <span className="chev">▾</span>
      </button>
      {open && (
        <div className="usermenu-pop" role="menu">
          <div className="usermenu-head">
            <div className="av" style={{ background: user.colour ?? '#0E0E11' }}>{initials}</div>
            <div style={{ minWidth: 0 }}>
              <div className="nm">{user.name}</div>
              <div className="rl">{user.email}</div>
            </div>
          </div>
          <button className="usermenu-item" role="menuitem" onClick={() => go('/settings')}>
            <span className="ic">⚙</span> Settings
          </button>
          <button className="usermenu-item" role="menuitem" onClick={() => go('/account')}>
            <span className="ic">◈</span> Account
          </button>
          <div className="usermenu-sep" />
          <button className="usermenu-item danger" role="menuitem" onClick={() => void logout()}>
            <span className="ic">→</span> Logout
          </button>
        </div>
      )}
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
        {actions && <div className="rowflex">{actions}</div>}
        <ThemeToggle />
        <UserMenu />
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
