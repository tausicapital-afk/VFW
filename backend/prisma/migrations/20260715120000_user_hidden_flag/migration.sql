-- Operational-only accounts (demo / test logins) that keep working but must not
-- appear on the admin Users tab. Orthogonal to status: a hidden user is still
-- ACTIVE and authenticates normally; the flag only filters the people listings.
ALTER TABLE "User" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
