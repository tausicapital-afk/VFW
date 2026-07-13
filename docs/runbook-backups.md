# Runbook — Database backups and restore

Checked 2026-07-13, against the Railway project `VFW`
(`581fa82e-b3fe-4ee0-97f3-b7f09f0442e6`), Postgres volume `postgres-volume`
(volume instance `9f1b0857-8b11-427d-8dc9-b2329abb48a0`, region `us-west2`).

---

## 1. The finding: there are no backups

This was checked, not assumed. Railway's API reports, for the Postgres volume:

- **backup schedules: none.** `volumeInstanceBackupScheduleList` returns `[]`.
- **backups that exist: zero.** `volumeInstanceBackupList` returns `[]`.

**If the database is lost right now, every submission, payment, invoice and audit
entry is lost with it, permanently.** There is nothing to restore from. This is
the most serious issue found in the hardening pass — more serious than anything
about cookies or rate limits, because the others cost you an incident and this
one costs you the company's books.

Attempting to enable the schedule from the Railway CLI token returns
`Not Authorized`, so **this has to be done in the dashboard by the account
owner.** It is a two-minute job:

> Railway dashboard → project **VFW** → the **Postgres** service → **Backups**
> (under the volume / Data tab) → enable **Daily**, and if offered, **Weekly**
> and **Monthly** as well.

Then confirm it took: the schedule should list Daily/Weekly/Monthly, and the
first backup should appear within a day.

---

## 2. What a Railway backup actually is

A **snapshot of the whole disk** the database lives on — not a `.sql` file you
can open, and not per-table. That has two consequences people usually discover at
the worst moment:

- **Restoring is all-or-nothing.** You cannot pull one deleted submission out of
  a snapshot. You restore the entire database to how it looked at that moment,
  and anything written *after* that moment is gone.
- **Restoring is destructive.** It overwrites the live volume. A restore is
  itself an event that can lose data — the data written since the snapshot.

So the snapshot answers *"the database is gone / corrupted"*. It answers
*"someone deleted the wrong invoice an hour ago"* very badly.

---

## 3. Restore — the procedure

**Before you touch anything: take a fresh backup of the current state.** Even if
the current state is broken, it is the only copy of everything written since the
last snapshot, and the restore is about to overwrite it.

1. **Stop the writers.** In Railway, scale the **backend** service to 0 replicas
   (or pause it). If the API keeps serving while you restore, it will write into a
   database that is being replaced underneath it, and you will not be able to tell
   afterwards which rows are real.
2. **Take an on-demand backup of the current volume** (dashboard: Backups → Back
   up now). This is your undo.
3. **Pick the backup to restore.** Note its timestamp and say out loud what you
   are accepting: *everything written after this timestamp will be gone.*
4. **Restore it** (dashboard: Backups → the backup → Restore). Railway replaces
   the volume contents and restarts the Postgres service.
5. **Wait for Postgres to come back healthy**, then bring the backend back up.
6. **Verify before telling anyone it worked** — see §5.

Recovery point: with daily backups, **up to 24 hours of work can be lost.**
That is the number to say out loud to whoever is asking. If 24 hours of lost
invoices is not acceptable — and for accounting software it probably is not —
then §4 is not optional.

---

## 4. What is still missing: a backup you can actually read

Disk snapshots alone are a thin story for accounting data. Add a **logical dump**
(`pg_dump`) on a schedule, stored somewhere that is not Railway:

```bash
# Produces a real .sql file. Runs with the backend's env, so DATABASE_URL is
# injected by Railway and never printed or stored anywhere.
railway run --service backend -- \
  pg_dump "$DATABASE_URL" --no-owner --no-privileges --format=custom \
  > vfw-$(date +%Y%m%d).dump

# Restore it (into a scratch database first — never straight into production):
pg_restore --clean --no-owner --dbname "$TARGET_DATABASE_URL" vfw-20260713.dump
```

Why this is worth the effort:

- It restores **into a scratch database**, so you can look at the damage and pull
  out the three rows you actually need, instead of rolling the whole company back
  a day.
- It survives **losing the Railway account itself** — a snapshot inside the
  platform does not protect you from a billing dispute or a deleted project.
- It is **verifiable**. A dump you have restored is a backup; a snapshot you have
  never restored is a hope.

Store the dumps off-platform (the same S3/R2 bucket already planned for
documents is fine) and keep them for at least a fiscal year — this is accounting
data, and someone will eventually ask what a number looked like in March.

---

## 5. Verifying a restore

A restore is not finished when the service turns green. Check the things that
would actually be wrong if it half-worked:

```sql
-- Does the audit trail run right up to the restore point, with no hole?
SELECT max("createdAt") FROM "AuditEntry";

-- Do the money tables agree with themselves?
SELECT COUNT(*), SUM(total) FROM "Submission";
SELECT COUNT(*), SUM(amount) FROM "Payment";

-- Is the invoice sequence still ahead of every invoice issued?
--   If this comes back <= 0, the next invoice will reuse a number that is
--   already on a customer's invoice. Fix the sequence BEFORE anyone logs in.
SELECT s."nextInvoiceSeq" - COALESCE(MAX(sub."invoiceSeq"), 0)
FROM "Settings" s LEFT JOIN "Submission" sub ON true GROUP BY s."nextInvoiceSeq";
```

Then sign in and load one submission end to end. If the totals render and the
audit trail is intact, the restore is good.

---

## 6. Test it before you need it

Nobody's first restore should be during an outage. Once backups are on, do a
drill: restore the latest backup into a **scratch Railway environment**, point a
copy of the backend at it, sign in, open a submission. Time it. That number —
how long it takes to get back — is the only honest answer to "how bad is it if
the database dies", and right now the answer is *"we can't, there are no
backups."*
