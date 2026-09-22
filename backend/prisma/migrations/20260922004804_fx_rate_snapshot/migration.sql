-- CreateTable
CREATE TABLE "FxRateSnapshot" (
    "id" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "rates" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "FxRateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FxRateSnapshot_effectiveFrom_idx" ON "FxRateSnapshot"("effectiveFrom");

-- Backfill: seed one snapshot from whatever Settings.fxRates holds right now,
-- dated at migration time (today). Without this, every report ever run for a
-- period before this feature existed would find no snapshot at all and fall
-- through to ReportsService's live-Settings fallback — which is CORRECT for
-- those old periods (they never had per-period rates and must keep producing
-- the numbers they always did), but it would ALSO be the answer for every
-- period between "today" and "whenever Accounting next edits Settings",
-- which is wrong: those periods should already be pinned to today's rate,
-- not left to drift if the live rate later moves again before anyone saves
-- the settings form. This row closes that gap the moment the migration runs,
-- rather than leaving it open until the next manual edit.
--
-- gen_random_uuid() is Postgres core since v13 (this project targets v16), so
-- no extension needs enabling for this one-off id.
INSERT INTO "FxRateSnapshot" ("id", "effectiveFrom", "rates", "createdAt", "createdById")
SELECT gen_random_uuid()::text, CURRENT_DATE, "fxRates", CURRENT_TIMESTAMP, NULL
FROM "Settings"
WHERE "id" = 1;
