import { describe, expect, it } from 'vitest';
import { can, PERMISSIONS } from './acl';

describe('can', () => {
  it('denies a signed-out visitor', () => {
    expect(can('submission.create', undefined)).toBe(false);
    expect(can('submission.create', null)).toBe(false);
  });

  it('reads the permissions the server sent for the role', () => {
    const user = { permissions: ['submission.create', 'admin.manage'] };
    expect(can('submission.create', user)).toBe(true);
    expect(can('admin.manage', user)).toBe(true);
    expect(can('activity.view', user)).toBe(false);
  });

  it('denies everything when the server sent no permissions', () => {
    for (const p of PERMISSIONS) expect(can(p, {})).toBe(false);
  });
});
