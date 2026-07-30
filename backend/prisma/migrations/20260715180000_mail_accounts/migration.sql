-- Mail accounts: the SMTP mailboxes the app can send from. Previously a single
-- mailbox spread across ConfigSetting rows (MAIL_HOST, MAIL_USERNAME, …), which
-- left nowhere to put a second account and made switching sender a retype. One
-- row per mailbox, exactly one `isActive` (enforced in MailAccountService inside
-- a transaction). `password` is AES-256-GCM ciphertext. See src/config/.
--
-- The old MAIL_* ConfigSetting rows are deliberately left in place: EmailService
-- falls back to them while this table is empty, so a deployment mid-upgrade
-- keeps sending.
CREATE TABLE "MailAccount" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 465,
    "encryption" TEXT NOT NULL DEFAULT 'ssl',
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MailAccount_host_username_key" ON "MailAccount"("host", "username");

CREATE INDEX "MailAccount_isActive_idx" ON "MailAccount"("isActive");
