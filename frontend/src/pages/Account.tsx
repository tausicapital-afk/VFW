import { useAuth } from '../auth/AuthContext';
import { Page, ROLE_LABEL } from '../shell/Shell';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="f">
      <label>{label}</label>
      <input value={value} readOnly />
    </div>
  );
}

export function Account() {
  const { user } = useAuth();
  if (!user) return null;

  const initials = user.name.split(' ').map((p) => p[0]).slice(0, 2).join('');

  return (
    <Page crumb="Console" title="Account">
      <div className="card" style={{ maxWidth: 720 }}>
        <div className="hd"><h3>Profile</h3></div>
        <div className="bd">
          <div className="rowflex" style={{ gap: 14, marginBottom: 18 }}>
            <div
              className="av"
              style={{
                background: user.colour ?? '#0E0E11',
                width: 56, height: 56, borderRadius: '50%',
                display: 'grid', placeItems: 'center', color: '#fff',
                fontWeight: 700, fontSize: 18, fontFamily: 'Archivo', flex: '0 0 auto',
              }}
            >
              {initials}
            </div>
            <div>
              <div className="b" style={{ fontSize: 16 }}>{user.name}</div>
              <div className="mut sm">{ROLE_LABEL[user.role]}</div>
            </div>
          </div>

          <div className="fields">
            <Field label="Full name" value={user.name} />
            <Field label="Work email" value={user.email} />
            <Field label="Role" value={ROLE_LABEL[user.role]} />
            <Field label="Department" value={user.department ?? '—'} />
          </div>

          <div className="note" style={{ marginTop: 16 }}>
            Profile details are managed by an administrator. Contact your admin to update them.
          </div>
        </div>
      </div>
    </Page>
  );
}
