-- Mail accounts gain a `provider`: how the message leaves the building.
--
-- Railway silently drops every outbound SMTP port (measured from inside the
-- container: mail.veeb.co.ke:465 and :587 and smtp.gmail.com:465 all time out,
-- while api.github.com:443 connects in 73ms). So `smtp` can never deliver there,
-- however correct the mailbox — and an HTTP provider over 443 can. Both stay
-- supported: the cPanel mailbox is still right for any host that permits SMTP.
--
-- Existing rows are SMTP by definition, which the DEFAULT gives them.
ALTER TABLE "MailAccount" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'smtp';

-- host/username stop being meaningful for HTTP providers, so they need defaults
-- rather than being required of every row.
ALTER TABLE "MailAccount" ALTER COLUMN "host" SET DEFAULT '';
ALTER TABLE "MailAccount" ALTER COLUMN "username" SET DEFAULT '';

-- The old uniqueness (host, username) collapses for HTTP providers, where both
-- are blank: a second Resend account would collide with the first. Scope it by
-- provider and from-address instead, which is what actually identifies a sender.
DROP INDEX "MailAccount_host_username_key";

CREATE UNIQUE INDEX "MailAccount_provider_host_username_fromAddress_key"
  ON "MailAccount"("provider", "host", "username", "fromAddress");
