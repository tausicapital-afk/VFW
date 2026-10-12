import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { ALL_PERMISSIONS } from '../common/acl';
import { PrismaService } from '../prisma/prisma.service';

/** Administration -> Roles: create, edit, delete, and the guards around them. */
describe('roles', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  let sales: string;
  const LABEL = `Field Probe ${Date.now()}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, 'it@vanfashionweek.com');
    sales = await loginCookie(app, 'marielle@vanfashionweek.com');
  });

  afterAll(async () => {
    await prisma.roleDef.deleteMany({ where: { builtIn: false, label: { startsWith: 'Field Probe' } } });
    await app?.close();
  });

  it('lists the built-in roles and the permission catalogue to any signed-in user', async () => {
    const res = await http(app).get('/api/roles').set('Cookie', sales).expect(200);
    const keys = res.body.roles.map((r: { key: string }) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN']));
    expect(res.body.permissions).toHaveLength(ALL_PERMISSIONS.length);
  });

  it('only lets an administrator create a role', async () => {
    await http(app).post('/api/roles').set('Cookie', sales)
      .send({ label: LABEL, permissions: [] }).expect(403);
  });

  it('creates, edits and deletes a custom role', async () => {
    const created = await http(app).post('/api/roles').set('Cookie', admin)
      .send({ label: LABEL, permissions: ['submission.create', 'messaging.use'] }).expect(201);
    const key = created.body.key as string;
    expect(key).toMatch(/^FIELD_PROBE/);

    // Same name again, in another case, is refused.
    await http(app).post('/api/roles').set('Cookie', admin)
      .send({ label: LABEL.toLowerCase(), permissions: [] }).expect(400);

    const edited = await http(app).patch(`/api/roles/${key}`).set('Cookie', admin)
      .send({ label: `${LABEL} 2`, permissions: ['reports.view'] }).expect(200);
    expect(edited.body.permissions).toEqual(['reports.view']);
    expect(edited.body.key).toBe(key);

    await http(app).delete(`/api/roles/${key}`).set('Cookie', admin).expect(200);
    expect(await prisma.roleDef.findUnique({ where: { key } })).toBeNull();
  });

  it('refuses an unknown permission', async () => {
    await http(app).post('/api/roles').set('Cookie', admin)
      .send({ label: `${LABEL} bad`, permissions: ['no.such.thing'] }).expect(400);
  });

  it('will not delete a built-in role', async () => {
    await http(app).delete('/api/roles/SALES').set('Cookie', admin).expect(400);
    await http(app).delete('/api/roles/ADMIN').set('Cookie', admin).expect(400);
  });

  it('keeps every permission on Administrator whatever an edit sends', async () => {
    const before = await prisma.roleDef.findUniqueOrThrow({ where: { key: 'ADMIN' } });
    const res = await http(app).patch('/api/roles/ADMIN').set('Cookie', admin)
      .send({ permissions: [] });
    // Either refused (it is the caller's own role and would lose Administration)
    // or stored as everything — never stored as nothing.
    const after = await prisma.roleDef.findUniqueOrThrow({ where: { key: 'ADMIN' } });
    expect([200, 400]).toContain(res.status);
    expect(after.permissions.length).toBeGreaterThanOrEqual(before.permissions.length);
  });

  it('will not delete a role an account still holds', async () => {
    const created = await http(app).post('/api/roles').set('Cookie', admin)
      .send({ label: `${LABEL} held`, permissions: [] }).expect(201);
    const key = created.body.key as string;
    const rep = await prisma.user.findUniqueOrThrow({ where: { email: 'diego@vanfashionweek.com' } });
    await prisma.user.update({ where: { id: rep.id }, data: { role: key } });
    try {
      await http(app).delete(`/api/roles/${key}`).set('Cookie', admin).expect(400);
    } finally {
      await prisma.user.update({ where: { id: rep.id }, data: { role: rep.role } });
    }
  });

  it('applies a role edit to its holders on their next request', async () => {
    const before = await prisma.roleDef.findUniqueOrThrow({ where: { key: 'SALES' } });
    try {
      await prisma.roleDef.update({ where: { key: 'SALES' }, data: { permissions: [...before.permissions, 'reports.view'] } });
      await http(app).get('/api/reports/types').set('Cookie', sales).expect(200);
      await prisma.roleDef.update({ where: { key: 'SALES' }, data: { permissions: before.permissions } });
      await http(app).get('/api/reports/types').set('Cookie', sales).expect(403);
    } finally {
      await prisma.roleDef.update({ where: { key: 'SALES' }, data: { permissions: before.permissions } });
    }
  });
});
