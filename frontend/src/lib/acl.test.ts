import { ACL, can } from './acl';
import type { Role } from './types';

describe('can', () => {
  it('returns false when there is no role at all (signed-out / still loading)', () => {
    expect(can('submission.create', undefined)).toBe(false);
  });

  it('allows a role that is listed for the permission', () => {
    expect(can('submission.create', 'SALES')).toBe(true);
    expect(can('admin.manage', 'ADMIN')).toBe(true);
  });

  it('denies a role that is not listed for the permission', () => {
    expect(can('admin.manage', 'SALES')).toBe(false);
    expect(can('activity.view', 'MGR')).toBe(false);
  });

  it('scopes editAny to accounting/admin only, distinct from editOwn', () => {
    expect(can('submission.editOwn', 'SALES')).toBe(true);
    expect(can('submission.editAny', 'SALES')).toBe(false);
    expect(can('submission.editAny', 'ACCT')).toBe(true);
  });

  it('checks every permission against every role without throwing', () => {
    const roles: Role[] = ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'];
    for (const permission of Object.keys(ACL) as (keyof typeof ACL)[]) {
      for (const role of roles) {
        expect(typeof can(permission, role)).toBe('boolean');
      }
    }
  });

  it('everyone with an account can use messaging', () => {
    const roles: Role[] = ['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN'];
    for (const role of roles) {
      expect(can('messaging.use', role)).toBe(true);
    }
  });
});
