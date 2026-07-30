import type { INestApplication } from '@nestjs/common';
import { createTestApp, http, loginCookie } from '../../test/app';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The Invitations & approvals tab, through the real request path.
 *
 * The property that matters here: a soft delete is invisible to the admin AND
 * inert to the outside world. A row that has left the list but still lets
 * someone sign up, or still lets an account log in, is worse than no delete at
 * all — the admin believes it is gone. Every test below is some form of that.
 */

const ADMIN = 'it@vanfashionweek.com';
const SALES = 'marielle@vanfashionweek.com';

describe('invitations & approvals — edit and soft delete', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  const litter: string[] = [];

  const newInvite = async (body: object = {}) => {
    const res = await http(app)
      .post('/api/invitations')
      .set('Cookie', admin)
      .send({ role: 'SALES', department: 'Sales', ...body })
      .expect(201);
    litter.push(res.body.id as string);
    return res.body as { id: string; code: string; role: string; email: string | null };
  };

  const list = async () => {
    const res = await http(app).get('/api/invitations').set('Cookie', admin).expect(200);
    return res.body.invitations as { id: string; code: string; status: string }[];
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
  });

  afterAll(async () => {
    // These tests write real rows. Hard-delete them so a soft-delete test does
    // not quietly become a fixture for the next run.
    if (litter.length) {
      await prisma.invitation.deleteMany({ where: { id: { in: litter } } });
    }
    await app?.close();
  });

  describe('editing', () => {
    it('changes role, department and email, and the list agrees', async () => {
      const inv = await newInvite({ role: 'SALES', email: 'edit.me@example.com' });

      const res = await http(app)
        .patch(`/api/invitations/${inv.id}`)
        .set('Cookie', admin)
        .send({ role: 'ACCT', department: 'Accounting', email: 'moved@example.com' })
        .expect(200);

      expect(res.body).toMatchObject({
        role: 'ACCT',
        department: 'Accounting',
        email: 'moved@example.com',
        code: inv.code, // the code is never reissued by an edit
      });
    });

    it('clears the address back to an open code when email is null', async () => {
      const inv = await newInvite({ email: 'someone@example.com' });

      const res = await http(app)
        .patch(`/api/invitations/${inv.id}`)
        .set('Cookie', admin)
        .send({ email: null })
        .expect(200);

      expect(res.body.email).toBeNull();
    });

    it('records what actually changed in the audit trail, not the whole form', async () => {
      const inv = await newInvite({ role: 'SALES', department: 'Sales' });

      await http(app)
        .patch(`/api/invitations/${inv.id}`)
        .set('Cookie', admin)
        // department is resent unchanged — it must not show up as a change.
        .send({ role: 'MGR', department: 'Sales' })
        .expect(200);

      const entry = await prisma.auditEntry.findFirst({
        where: { action: 'INVITE_UPDATED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry?.payload).toMatchObject({
        before: { role: 'SALES' },
        after: { role: 'MGR' },
      });
      expect(entry?.payload).not.toHaveProperty('after.department');
    });

    it('refuses to edit an invitation that has already been redeemed', async () => {
      const inv = await newInvite();
      await prisma.invitation.update({ where: { id: inv.id }, data: { usedAt: new Date() } });

      const res = await http(app)
        .patch(`/api/invitations/${inv.id}`)
        .set('Cookie', admin)
        .send({ role: 'ADMIN' })
        .expect(400);
      expect(res.body.message).toMatch(/redeemed/i);
    });

    it('rejects an email that already belongs to an account', async () => {
      const inv = await newInvite();
      await http(app)
        .patch(`/api/invitations/${inv.id}`)
        .set('Cookie', admin)
        .send({ email: SALES })
        .expect(400);
    });

    it('will not let the code or the expiry be edited', async () => {
      const inv = await newInvite();
      // forbidNonWhitelisted: anything not on the DTO is a 400, not a silent drop.
      await http(app)
        .patch(`/api/invitations/${inv.id}`)
        .set('Cookie', admin)
        .send({ code: 'VFW-HACKED' })
        .expect(400);
      await http(app)
        .patch(`/api/invitations/${inv.id}`)
        .set('Cookie', admin)
        .send({ expiresAt: '2030-01-01' })
        .expect(400);
    });
  });

  describe('soft delete', () => {
    it('takes the row off the list but keeps it on file', async () => {
      const inv = await newInvite();
      expect((await list()).map((i) => i.id)).toContain(inv.id);

      await http(app).delete(`/api/invitations/${inv.id}`).set('Cookie', admin).expect(200);

      expect((await list()).map((i) => i.id)).not.toContain(inv.id);
      const row = await prisma.invitation.findUnique({ where: { id: inv.id } });
      expect(row?.deletedAt).toBeInstanceOf(Date);
    });

    it('stops the code being redeemed — a deleted invitation is not a live one', async () => {
      const inv = await newInvite();
      await http(app).delete(`/api/invitations/${inv.id}`).set('Cookie', admin).expect(200);

      const res = await http(app)
        .post('/api/auth/signup')
        .send({
          code: inv.code,
          name: 'Trying It On',
          email: `deleted.code.${Date.now()}@example.com`,
          password: 'Vfw@2026!test',
        })
        .expect(400);
      expect(res.body.message).toMatch(/not recognised|expired|already been used/i);
    });

    it('is idempotent-safe: deleting twice 404s rather than re-stamping', async () => {
      const inv = await newInvite();
      await http(app).delete(`/api/invitations/${inv.id}`).set('Cookie', admin).expect(200);
      await http(app).delete(`/api/invitations/${inv.id}`).set('Cookie', admin).expect(404);
    });

    it('leaves an audit entry naming the code', async () => {
      const inv = await newInvite();
      await http(app).delete(`/api/invitations/${inv.id}`).set('Cookie', admin).expect(200);

      const entry = await prisma.auditEntry.findFirst({
        where: { action: 'INVITE_DELETED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry?.detail).toContain(inv.code);
    });
  });

  describe('authorization', () => {
    it('is admin-only — a rep cannot edit or delete', async () => {
      const inv = await newInvite();
      const rep = await loginCookie(app, SALES);

      await http(app)
        .patch(`/api/invitations/${inv.id}`)
        .set('Cookie', rep)
        .send({ role: 'ADMIN' })
        .expect(403);
      await http(app).delete(`/api/invitations/${inv.id}`).set('Cookie', rep).expect(403);
      await http(app).patch('/api/users/no-such-id').set('Cookie', rep).send({ name: 'x' }).expect(403);
      await http(app).delete('/api/users/no-such-id').set('Cookie', rep).expect(403);
    });
  });
});

describe('pending sign-ups — edit and soft delete', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: string;
  const litter: string[] = [];

  /** A real PENDING account, made the way a real one is: redeem an invitation. */
  const newSignup = async (over: { role?: string; department?: string } = {}) => {
    const inv = await http(app)
      .post('/api/invitations')
      .set('Cookie', admin)
      .send({ role: over.role ?? 'SALES', department: over.department ?? 'Sales' })
      .expect(201);

    const email = `pending.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.com`;
    await http(app)
      .post('/api/auth/signup')
      .send({ code: inv.body.code, name: 'Casey Pending', email, password: 'Vfw@2026!test' })
      .expect(201);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    litter.push(user.id);
    return { id: user.id, email };
  };

  const queue = async () => {
    const res = await http(app).get('/api/users/pending').set('Cookie', admin).expect(200);
    return res.body.users as { id: string; role: string; name: string }[];
  };

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    admin = await loginCookie(app, ADMIN);
  });

  afterAll(async () => {
    if (litter.length) {
      await prisma.emailOtp.deleteMany({ where: { userId: { in: litter } } });
      await prisma.user.deleteMany({ where: { id: { in: litter } } });
    }
    await app?.close();
  });

  it('edits the details someone typed on the signup form', async () => {
    const u = await newSignup({ role: 'SALES' });

    await http(app)
      .patch(`/api/users/${u.id}`)
      .set('Cookie', admin)
      .send({ name: 'Casey Corrected', role: 'ACCT', department: 'Accounting', phone: '+1 604 555 0100' })
      .expect(200);

    const row = await queue().then((rows) => rows.find((r) => r.id === u.id));
    expect(row).toMatchObject({ name: 'Casey Corrected', role: 'ACCT' });
  });

  it('carries an edited role through the approval — the fix is what gets approved', async () => {
    const u = await newSignup({ role: 'SALES' });

    await http(app).patch(`/api/users/${u.id}`).set('Cookie', admin).send({ role: 'MGR' }).expect(200);
    await http(app).post(`/api/users/${u.id}/approve`).set('Cookie', admin).expect(201);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row).toMatchObject({ role: 'MGR', status: 'ACTIVE' });
  });

  it('will not let the email be edited — it is the identity that was verified', async () => {
    const u = await newSignup();
    await http(app)
      .patch(`/api/users/${u.id}`)
      .set('Cookie', admin)
      .send({ email: 'someone.else@example.com' })
      .expect(400);
  });

  // Editing is no longer pending-only — Users & roles maintains established
  // accounts through the same PATCH. What stays refused is deciding the approval
  // through it: an account becomes ACTIVE by being approved, with a reason on
  // record, and never by way of a form that edits a phone number.
  it('will not approve an account by writing its status', async () => {
    const u = await newSignup();

    const res = await http(app)
      .patch(`/api/users/${u.id}`)
      .set('Cookie', admin)
      .send({ status: 'ACTIVE' })
      .expect(400);
    expect(res.body.message).toMatch(/use approve or reject/i);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.status).toBe('PENDING');
  });

  it('soft delete takes the sign-up out of the queue but keeps the row', async () => {
    const u = await newSignup();
    expect((await queue()).map((r) => r.id)).toContain(u.id);

    await http(app).delete(`/api/users/${u.id}`).set('Cookie', admin).expect(200);

    expect((await queue()).map((r) => r.id)).not.toContain(u.id);
    const row = await prisma.user.findUnique({ where: { id: u.id } });
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  it('a deleted account cannot log in, even once it is ACTIVE', async () => {
    const u = await newSignup();
    // Approve first, so the only thing standing between it and a session is the
    // delete — otherwise PENDING would block the login and prove nothing.
    await http(app).post(`/api/users/${u.id}/approve`).set('Cookie', admin).expect(201);
    await http(app).delete(`/api/users/${u.id}`).set('Cookie', admin).expect(200);

    const res = await http(app)
      .post('/api/auth/login')
      .send({ email: u.email, password: 'Vfw@2026!test' })
      .expect(401);
    expect(res.body.message).toMatch(/not active/i);
  });

  it('kills a session the deleted account already held', async () => {
    const u = await newSignup();
    await http(app).post(`/api/users/${u.id}/approve`).set('Cookie', admin).expect(201);

    const theirs = await loginCookie(app, u.email, 'Vfw@2026!test');
    await http(app).get('/api/contacts').set('Cookie', theirs).expect(200);

    await http(app).delete(`/api/users/${u.id}`).set('Cookie', admin).expect(200);

    // The guard re-reads the user on every request, so the live cookie dies now
    // rather than at expiry.
    await http(app).get('/api/contacts').set('Cookie', theirs).expect(401);
  });

  it('will not let an admin delete themselves out of the console', async () => {
    const me = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const res = await http(app).delete(`/api/users/${me.id}`).set('Cookie', admin).expect(400);
    expect(res.body.message).toMatch(/your own account/i);
  });
});
