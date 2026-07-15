-- Health probe history: the record behind the public status page.
--
-- A live healthcheck can only say "up right now" — the 90-day uptime bars need
-- a history, so a background prober writes one row per component per check.
-- `status` is OPERATIONAL | DEGRADED | DOWN | UNCONFIGURED, where UNCONFIGURED
-- means credentials were never set (not an outage, and excluded from uptime).
-- Rows are aged out after 90 days, the same window the page draws.
-- See backend/src/health/.
CREATE TABLE "HealthProbe" (
    "id" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "error" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HealthProbe_pkey" PRIMARY KEY ("id")
);

-- The page's read: one component, last 90 days, bucketed by day.
CREATE INDEX "HealthProbe_component_checkedAt_idx" ON "HealthProbe"("component", "checkedAt");

-- Retention sweeps by age across every component.
CREATE INDEX "HealthProbe_checkedAt_idx" ON "HealthProbe"("checkedAt");
