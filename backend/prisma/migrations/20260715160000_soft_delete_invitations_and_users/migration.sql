-- Soft delete for the admin Invitations & approvals tab.
--
-- Nullable with no default and no backfill: every existing row is live, which is
-- exactly what NULL already means here, so this is additive and safe to deploy
-- ahead of the code that reads it.
-- No index on either column, deliberately: the admin listings that filter on
-- `deletedAt IS NULL` scan a small table either way, and the auth guard reads
-- deletedAt off a row it has already found by primary key.
ALTER TABLE "Invitation" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);
