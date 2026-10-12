import { useRoles } from '../lib/roles';
import type { Role } from '../lib/types';

/** A role's current label, as an admin named it under Administration -> Roles. */
export function RoleName({ role }: { role: Role | null | undefined }) {
  const { label } = useRoles();
  return <>{label(role)}</>;
}

/** The roles as `<option>`s, for a role picker. */
export function RoleOptions() {
  const { roles } = useRoles();
  return (
    <>
      {roles.map((r) => (
        <option key={r.key} value={r.key}>{r.label}</option>
      ))}
    </>
  );
}
