-- Roles become rows an admin can create, edit and delete (Administration ->
-- Roles). The five built-ins are seeded here with exactly the permissions the
-- old hard-coded matrix gave them (common/acl.ts), so nobody's access changes
-- on deploy. User.role and Invitation.role keep their values ("SALES", ...),
-- now as text referencing RoleDef.key instead of the Role enum.

-- CreateTable
CREATE TABLE "RoleDef" (
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleDef_pkey" PRIMARY KEY ("key")
);

-- Seed the built-in roles
INSERT INTO "RoleDef" ("key", "label", "permissions", "builtIn", "updatedAt") VALUES
  ('SALES', 'User', ARRAY['submission.create', 'submission.editOwn', 'submission.queueView', 'installment.plan', 'installment.mark', 'contacts.view', 'contacts.create', 'feedback.record', 'messaging.use', 'email.viewOwn', 'attendance.mark', 'payroll.viewOwn', 'payroll.submit']::TEXT[], true, CURRENT_TIMESTAMP),
  ('INTERN', 'Intern', ARRAY['submission.create', 'submission.editOwn', 'installment.plan', 'installment.mark', 'messaging.use', 'email.viewOwn', 'attendance.mark', 'payroll.viewOwn', 'payroll.submit']::TEXT[], true, CURRENT_TIMESTAMP),
  ('ACCT', 'Accounting', ARRAY['submission.create', 'submission.editOwn', 'submission.editAny', 'submission.viewAll', 'submission.queueView', 'submission.approve', 'submission.reject', 'submission.return', 'submission.void', 'accounting.fields', 'quickbooks.export', 'invoice.generate', 'installment.plan', 'installment.mark', 'reports.view', 'contacts.view', 'contacts.create', 'feedback.view', 'feedback.record', 'internal.comment', 'internal.view', 'messaging.use', 'email.viewOwn', 'email.viewAll', 'email.send', 'admin.manage', 'attendance.mark', 'attendance.viewTeam', 'payroll.viewOwn', 'payroll.viewAll', 'payroll.submit', 'payroll.approve', 'payroll.manageTiers', 'activity.view']::TEXT[], true, CURRENT_TIMESTAMP),
  ('MGR', 'Sales Manager', ARRAY['submission.create', 'submission.editOwn', 'submission.viewAll', 'installment.plan', 'installment.mark', 'reports.view', 'contacts.view', 'feedback.view', 'feedback.record', 'internal.comment', 'internal.view', 'messaging.use', 'email.viewOwn', 'email.viewAll', 'attendance.mark', 'attendance.viewTeam', 'payroll.viewOwn', 'payroll.submit']::TEXT[], true, CURRENT_TIMESTAMP),
  ('ADMIN', 'Administrator', ARRAY['submission.create', 'submission.editOwn', 'submission.editAny', 'submission.viewAll', 'submission.queueView', 'submission.approve', 'submission.reject', 'submission.return', 'submission.void', 'accounting.fields', 'quickbooks.export', 'invoice.generate', 'installment.plan', 'installment.mark', 'reports.view', 'leaderboard.view', 'contacts.view', 'contacts.create', 'feedback.view', 'feedback.record', 'internal.comment', 'internal.view', 'messaging.use', 'email.viewOwn', 'email.viewAll', 'email.send', 'admin.manage', 'attendance.mark', 'attendance.viewTeam', 'payroll.viewOwn', 'payroll.viewAll', 'payroll.submit', 'payroll.approve', 'payroll.manageTiers', 'activity.view']::TEXT[], true, CURRENT_TIMESTAMP);

-- Enum -> text
ALTER TABLE "User" ALTER COLUMN "role" TYPE TEXT USING "role"::TEXT;
ALTER TABLE "Invitation" ALTER COLUMN "role" TYPE TEXT USING "role"::TEXT;
DROP TYPE "Role";

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_role_fkey" FOREIGN KEY ("role") REFERENCES "RoleDef"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_role_fkey" FOREIGN KEY ("role") REFERENCES "RoleDef"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
