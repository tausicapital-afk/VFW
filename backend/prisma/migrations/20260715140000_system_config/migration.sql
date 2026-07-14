-- System configuration: operational credentials (SMTP, object storage) moved
-- out of .env / Railway variables and into the database, so a non-technical
-- administrator can set them from the console. One row per setting, keyed by the
-- same name as the environment variable it shadows. `encrypted` marks a secret
-- whose `value` is AES-256-GCM ciphertext (never plaintext, never sent to the
-- browser). See backend/src/config/.
CREATE TABLE "ConfigSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfigSetting_pkey" PRIMARY KEY ("key")
);
