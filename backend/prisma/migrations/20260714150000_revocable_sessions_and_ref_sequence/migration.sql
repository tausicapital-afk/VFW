-- Revocable sessions: a session JWT is pinned to this value, so bumping it
-- invalidates every token already issued to that user.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- Gapless, race-free submission refs. Allocated by incrementing this counter
-- inside the creating transaction (a row lock), rather than by counting rows —
-- two concurrent creates read the same count and collide on "ref" @unique.
ALTER TABLE "Settings" ADD COLUMN "nextSubmissionSeq" INTEGER NOT NULL DEFAULT 1001;

-- Backfill: start the counter past whatever refs already exist, or the first
-- create after this migration would reissue a ref that is already taken. Refs
-- look like S-26-1007; take the numeric tail, not the whole string.
UPDATE "Settings"
SET "nextSubmissionSeq" = GREATEST(
  "nextSubmissionSeq",
  COALESCE(
    (SELECT MAX(CAST(split_part("ref", '-', 3) AS INTEGER)) + 1
     FROM "Submission"
     WHERE "ref" ~ '^S-[0-9]+-[0-9]+$'),
    1001
  )
)
WHERE "id" = 1;
