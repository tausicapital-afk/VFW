# VFW Console — User Manual

VFW Console is the system Van Fashion Week (and its sister events, VKFW and GFC)
uses to run the business side of a fashion show: booking a designer's package,
getting the sale approved and invoiced, tracking payments, running payroll,
messaging colleagues, and reporting on how the season is going.

This manual is organized the same way the app is organized. Each section below
covers one screen — what it's for, and exactly what each of the five staff roles
can see and do there. If you only ever use two or three screens, you can skip
straight to those sections; the first two sections (the roles, and how
permissions work) are worth reading once regardless of your role, because they
explain *why* certain buttons are missing or greyed out for you — it is
deliberate, not a bug.

---

## The five roles

Every person who signs in holds exactly one of five roles. A role decides which
screens you can open and which actions you can take; it does **not** decide
which *records* you can see within a screen — that is a separate rule, covered
in each module's section below (in short: most staff see their own work, while
Accounting, Sales Management and Administration see everyone's).

| Role | Who this is |
| --- | --- |
| **User** | The standard staff account: someone who sells a package to a designer and owns the relationship with that account, and anyone else who does day-to-day work in the console without needing one of the specialist roles below. |
| **Intern** | A supervised trainee learning the sales role. Can draft and manage sales the same way a User can, but does not yet get the customer contact book or the feedback tools — those hold designers' personal contact details. |
| **Accounting** | Reviews and approves sales, handles invoicing, payments, and the QuickBooks hand-off, and is a second administrator for the whole system. |
| **Sales Manager** | Oversees the sales team's numbers and hours. Can see everything a User can see, and more — but cannot create, approve, or export a sale, and cannot see anyone's pay. This role watches the business, it doesn't operate the money side of it. |
| **Administrator** | Full access, including everything Accounting can do, plus system configuration: user accounts, the product catalogue, and settings. |

A few things worth understanding up front, because they explain a lot of what
follows:

- **"User" is the name of a role, not just "somebody using the console."**
  Everyone who signs in is using the system; only the accounts on this
  particular role are labelled **User**. It was called *Sales Representative*
  until recently and was renamed because it had stopped being sales-only —
  salespeople and other staff are both on it, and a person on this role who
  never sells anything is perfectly normal. Nothing about what the role can do
  changed with the name.
- **Accounting and Administrator are equals.** Both can approve sales, manage
  the catalogue, and manage user accounts. Accounting holds this so that
  account recovery (for example, restoring a locked-out Administrator) never
  depends on one single person being reachable. The trade-off is real and
  worth knowing: anyone who can change roles can promote themselves to
  Administrator, so this is a high-trust position on both sides.
- **The Sales Manager sees more than they can act on.** A manager can see
  every sale, every report, and every team member's hours — but cannot create
  a sale, approve one, or export one. That authority stays with Accounting and
  Administration.
- **"Who can approve" and "who can see" are different questions**, and the
  system is strict about keeping them separate. A rule you'll see repeated
  throughout this manual: whoever *creates or requests* something is never
  the same person who *approves* it — even an Administrator cannot approve
  their own submitted work.
- **A role decides which screens you see; a second, separate rule decides
  whose records you see on them.** Someone on the User role looking at
  Submissions sees only their own deals; Accounting, Sales Management and
  Administration see everyone's. This "row scoping" is called out explicitly
  wherever it applies.

---

## Work

### Dashboard

The landing screen after you sign in. Accounting and Administrators see what is
currently waiting on their approval; everyone else sees a summary of their own
open work.

*Everyone can see this screen — it just shows different things depending on
your role.*

### New submission

This is how a sale gets entered into the system: choose the contact/designer,
the show, a package, any add-ons, a discount if one applies, and a deposit.

**Who can create a submission:** Users, Interns, and Administrators.
Accounting and Sales Managers do not create sales — they review them.

**What happens when you submit:**

1. You choose the show, the package, and any add-ons. The screen shows you a
   running total as you build the sale — but it is clearly labeled
   *"Indicative only."* The real total is calculated by the server the moment
   you submit, from the same rate card, and that number is the one that
   counts. You are not trusted to type in a price, and neither is anyone
   else — the system always calculates the total itself.
2. **A discount only ever reduces the package price — never the add-ons.**
   If you apply a 10% discount to a package plus add-ons, only the package
   portion is discounted.
3. **Commission is calculated on the discounted price, before tax** — never on
   the tax itself, and never on the full sticker price before your discount.
   You are paid on the actual revenue you brought in.
4. If a payment schedule (installments) is agreed with the designer, you can
   set that up right away, and mark payments as received as they come in —
   more on this under **Submissions** below.
5. The sale is created in **Pending** status and goes to the Approval queue.

**Customizing a package for one sale.** You are not limited to the catalogue
exactly as priced. On any individual sale you can change the price, rename the
package, change what's included, or build something entirely custom for that
designer. This does not touch the catalogue for anyone else — it is a one-time
deviation for this sale only. It does, however, flag the sale for an extra
approval step (see **Approval queue** below), because Accounting needs to
knowingly sign off on a non-standard deal.

**A contact is created automatically.** The first time you submit a sale for a
new brand, that brand is added to the Contacts book automatically — you don't
need to add it separately first.

### Submissions

The list of every sale you're allowed to see, with a detail page for each one.

| | User / Intern | Accounting | Sales Manager | Administrator |
| --- | :-: | :-: | :-: | :-: |
| See the list | Own sales only | Everyone's | Everyone's | Everyone's |
| Edit a sale before approval | Own sales | Any | — | Any |
| Edit a sale after approval | — | Any (as an "Amend") | — | Any |
| Approve, reject, or return a sale | — | Yes | — | Yes |
| Generate/download the invoice | — | Yes | — | Yes |
| Send the invoice by email | — | Yes | — | Yes |
| Record or undo a payment | Yes | Yes | Yes | Yes |
| Void a sale (soft-delete) | — | Yes | — | Yes |

**Opening a sale.** Clicking anywhere on a row (or pressing Enter on it) opens
a quick-look panel over the list: the customer and designer, the show, package
and rep, the dates it was submitted and approved, and the full money breakdown
in the currency the sale was made in — package, add-ons, any discount, net
revenue, tax, total, paid, balance and commission — plus the sales notes if any
were left. It is read-only; **Open full record** takes you to the detail page
where the sale is actually worked on. Escape or a click outside closes it. This
is a faster way to check a figure than loading the whole record, and it works
the same way on the Dashboard's submissions card and on the voided list.

**Editing a sale, in plain terms.** Before a sale is approved, it belongs to
whoever created it (or Accounting/Admin, who can fix anyone's mistake). The
button reads **Edit**. Once a sale is approved, only Accounting or an
Administrator can still change it, and the button changes to **Amend** —
amending keeps the sale's approval rather than sending it back through the
queue. If a sale has already been sent to QuickBooks, the screen warns you
that QuickBooks will not automatically pick up any change you make there —
someone will need to fix it on the QuickBooks side by hand.

**The invoice number.** Before a sale is approved, its invoice number (if one
is typed in early) belongs to whoever can edit the sale. After approval, only
Accounting or an Administrator can set or change it — by then it may already be
on a document in a client's inbox, and the screen reminds you of that risk
before you save a change.

**Payment plans (installments).** Anyone who can work a sale — not just
Accounting — can set up a payment schedule and mark installments as paid. The
thinking here: whoever sold the deal is usually the one talking to the
designer about payment, so they shouldn't have to route every payment update
through Accounting. Two different actions are involved:

- **Scheduling a plan** just sets expectations — it does not move any money
  and can be adjusted freely.
- **Marking an installment paid** posts a real payment to the ledger and
  reduces the sale's balance.

**Undoing a payment never erases it.** If a payment is marked paid by mistake,
"undo" adds a matching negative entry rather than deleting the original — so
the payment history always shows exactly what happened, including corrections.
This is on purpose: a financial record you can quietly edit is a financial
record you can't trust.

**Voiding a sale** is a soft delete — Accounting or an Administrator can void
a sale to hide it from lists and reports, but it isn't gone. It's kept for the
audit trail and can be reversed.

### Contacts

The customer book — every designer/brand you've sold to, searchable by brand,
designer name, or company.

**Who can see it:** Users, Accounting, Sales Managers, and
Administrators. **Interns cannot** — the contact book holds designers'
personal emails and phone numbers, and an intern is a supervised trainee who
doesn't yet get access to that.

**Who can add a contact directly:** Users, Accounting, and
Administrators (not Sales Managers, not Interns).

A User sees only the brands they've personally sold to or entered; other
roles see everyone's. Opening a contact shows their **lifetime value** (the
total of everything they've bought that was actually approved — a returned
or rejected deal doesn't count) and their full history of sales with you.

### Messages

Real-time internal chat with your colleagues — direct messages or group
chats. Everyone can use it, and there's no restriction on who you can message.
A small badge on the navigation menu shows how many unread messages you have.

### Emails

A log of every email the system has sent or received on your behalf —
verification codes, invitations, password resets, and invoices.

**Everyone can open this screen**, but what you see depends on your role:
Users and Interns see only mail connected to them; Accounting, Sales
Managers, and Administrators see the full company log. **Sending** an invoice
by email is an accounting action (Accounting and Administrators only) and is
done from the sale itself, not from this screen — this screen is where you
go afterward to confirm it actually sent.

### Approval queue

Where Accounting and Administrators review sales that are waiting for
sign-off. Users can also open this screen — to see where their own
submission currently sits — but cannot act on it.

**Why reading and deciding are separate permissions:** the person who created
a sale should be able to check on its status without needing to ask someone
else. But *acting* on it — approving, rejecting, or sending it back — has to
stay with someone who didn't create it. That is the "maker and checker must be
different people" rule mentioned earlier, applied here directly.

**What happens when Accounting reviews a sale:**

- **A normal sale** opens a simple approval box: enter a GL account and cost
  centre, and approve.
- **A sale discounted more than the company's threshold** (15% by default,
  but this is configurable) will not approve with a simple click. The system
  refuses and tells you exactly why:

  > *"This sale is discounted 25.00%, above the 15.00% that needs accounting
  > sign-off. Re-send with acknowledgeDiscountOverride: true to approve it
  > anyway."*

  In the screen, this appears as a checkbox you must explicitly tick before
  the Approve button will submit. This is deliberate friction: a deep
  discount should never be approved without someone consciously saying "yes,
  I saw that and I'm approving it anyway." That acknowledgment is recorded in
  the sale's history.
- **A sale with a customized or non-catalogue package** (see **New
  submission** above) needs its own, *separate* sign-off — acknowledging the
  discount is not enough on its own. The approval box shows the rate-card
  price side by side with what was actually charged, so the approver can see
  exactly what they're agreeing to before ticking the box. A sale can trigger
  both checks at once, and both must be ticked.
- **Returning a sale** requires a written reason — you cannot send a sale
  back to a rep without explaining why. It lands in a "Returned to sales"
  list, where the rep can fix it and resubmit — there's a shortcut to edit it
  directly from that list.

### QuickBooks

Where approved sales get exported to the company's QuickBooks accounting
system, and a ledger of everything already exported.

**Who can use it:** Accounting and Administrators only.

Exporting posts the sale as an invoice in QuickBooks and marks it as
"Exported" in VFW Console. Once a sale is exported, editing it in VFW Console
still works, but you're warned that the change will **not** automatically
update QuickBooks — someone has to fix the QuickBooks side separately.

---

## People

### Attendance

Your monthly timesheet — a calendar where each day can be marked with a
status, clock-in/clock-out times, or a note, plus quick Clock In / Clock Out
buttons for today.

**Everyone can see and mark their own attendance.** Accounting, Sales
Managers, and Administrators additionally get a **Team** tab showing every
active staff member's month at a glance — including people who recorded
nothing at all, which is the point of that view (it surfaces gaps, not just
entries). Opening a person from the Team tab lets a manager correct their
day if needed, and any correction made by someone other than the person
themself is recorded and clearly labeled as a correction, not a self-report.

**A couple of details worth knowing:**

- If you enter both a start and finish time, your hours are calculated from
  those times automatically — a typed total is only used when times aren't
  given, so your record can never contradict itself.
- Each day can only have one record. Re-entering a day overwrites what was
  there before, rather than adding a second entry.

### Payroll

What you (or, if you have the right access, everyone) earned in a given
period, broken down into base pay, commission, and the total.

| | Everyone | Accounting / Administrator |
| --- | :-: | :-: |
| See your own pay | Yes | Yes |
| See everyone's pay | — | Yes |
| Submit your period for approval | Yes | Yes |
| Approve/reject submitted pay | — | Yes |

**Choosing the period.** The screen opens on the current calendar month and the
‹ › arrows step a month at a time, which is what most payroll runs are. **Custom
range…** swaps those arrows for two date boxes so a period can be anything else:
a biweekly cycle, someone's final two weeks before they leave, a one-off
correction window. Everything on the screen follows the period you pick — the
statement, the run, the sales panel, and the payslip you download. A period that
happens to run from the 1st to the last of a month is still just called *August
2026*; anything else is spelled out end to end.

**Sales Managers do not see anyone's pay figures**, including their own
team's — even though they *can* see the team's hours in Attendance. This is
the sharpest line in the whole permission system: "is my team showing up?"
and "what does my team earn?" are treated as genuinely different questions,
answered to different people.

**How your pay is calculated, in plain terms:**

- **Base pay** depends on your pay type, set by Administration: a flat salary,
  an hourly rate multiplied by your logged hours, or no base at all if you're
  paid on commission only.
- **Whether you're on commission** is a separate setting, so an account can be
  paid on commission, on a salary, or on both. If you're not on commission, the
  statement says so beside the commission line rather than showing you a rate you
  aren't earning at.
- **Commission** is the total commission on every sale you closed that was
  *approved* in that period (not just submitted) — using the commission rate
  that was locked in when each sale was made, so a rate change today never
  moves money already earned. Coming off commission works the same way: it
  stops your next sale earning any and never rewrites one already on the books.
- The screen also shows how much of your commission is tied to invoices the
  client hasn't paid yet — this doesn't reduce what you're owed, it's just
  shown so nobody is surprised that some of their "earned" total is still
  outstanding.

**The sales behind the commission.** Under the statement is a *Sales* panel
showing what that person actually sold in the period: how many deals, the net
revenue commission is struck on, the commission itself, progress against their
target, what has been collected against what is still outstanding, and a
**Who it came from** table breaking the period down client by client.

The panel has its own **Export** button — PDF, Excel or CSV — which hands over
the client breakdown for whichever period is on screen. Every row repeats the
period and the person, so several exports can be stacked into one sheet to build
up a longer history. Whose figures you can export is decided the same way the
screen decides: your own always, anyone else's only if you can already see their
pay.

The same panel appears on an account in Administration → Users & roles, from the
same figures — so the two screens can never give different answers about what
somebody sold.

**Downloading a payslip.** The *Payslip (PDF)* button on the period you are
looking at produces a one-page document you can print, file or send on. It
shows the period and the person it is for, how they are paid, each earnings
line beside the arithmetic it came from (rate x hours, or the sales behind the
commission), the attendance and sales the figures were derived from, and — if
the period has been submitted for approval — its status, who reviewed it and
when. It is the same statement as the screen, never a second calculation, so
the two can never disagree.

The same rule as the screen decides whose payslip you can pull: your own
always, anyone else's only if you can already see their pay. Every payslip
produced is recorded in the audit trail, including your own — a document that
gets forwarded should be traceable to whoever produced it.

**Submitting and approving pay.** Your statement is calculated fresh every time
you open it — nothing is saved until you actually submit it for approval.
Submitting freezes the figures for that exact period, so a timesheet or a sale
corrected afterwards will not quietly move what you claimed; if the two drift
apart, the screen says so and you can resubmit. Once submitted, Accounting can
review the figures, edit them if needed (always with a required written reason
— the save button stays disabled until you type one), and then approve or
reject. As with sale approvals, you cannot approve your own submission, no
matter your role. Once approved, the amount counts toward your running lifetime
earnings total, visible on this screen and on your Account page.

One submission exists per person per period, so resubmitting the same range
replaces your earlier claim rather than adding a second one. Submitting a
*different* range is a separate claim — overlapping periods are not detected
for you, so agree the cycle with Accounting before switching off calendar
months.

### Leaderboard

Ranks active accounts on the **User** role by performance over a chosen
period. Everyone can see it — showing everyone's numbers to everyone is the
entire point of a leaderboard. (The screen still calls these accounts
"representatives" in a couple of places; it means the same people.)

Ranking is based on a score, not raw revenue, made up of: revenue against
target, how many of your submissions get approved, how much of what you've
sold has actually been collected, and repeat business from your customers.
Someone who blows past their revenue target doesn't get extra credit for the
excess — the revenue portion of the score caps at 100% of target, so
consistently *collecting* what you sell and keeping customers coming back
matter just as much as closing the sale in the first place.

**Feedback and internal notes never affect this score, on purpose** — even a
glowing or scathing note about a rep has zero effect on where they rank. Those
tools (below) are for coaching, not for scoring.

### Designer feedback

Star ratings and notes left by designers about their experience.

**Who can see or record it:** Accounting, Sales Managers, and Administrators.
Users and Interns cannot access this screen.

Feedback is attached to the *designer/brand*, not to one specific sale — so
feedback recorded on one deal will show up against every deal for that same
brand, past and future.

### Internal notes

Internal operational comments about a specific sale — used by Accounting,
Production, Marketing, and Event Management teams to coordinate, kept
strictly out of anything client-facing.

**Who can see or write these:** Accounting, Sales Managers, and
Administrators.

**The one rule that overrides even being an Administrator:** nobody can ever
read internal notes about their *own* sale — not even an Administrator who
also happens to be the rep on that deal. If that applies to you, the entire
Internal Notes section simply won't appear on that sale's page. This is not a
bug or a missing feature — it's intentional, so a note about a person is
never visible to that same person, regardless of what else their role allows.

---

## Insight

### Reports

Ten different report types covering revenue, sales by event, sales by city,
package popularity, customer retention, outstanding receivables, payment
collection, individual rep performance, designer feedback trends, and
internal comment trends.

**Who can see it:** Accounting, Sales Managers, and Administrators.

Every consolidated figure is converted to the company's reporting currency
(CAD) using exchange rates that Administration keeps up to date — figures in
different currencies are never simply added together without conversion.

### Audit trail

A permanent, read-only record of business events across the whole
system — who approved what, who changed what, and when.

**Who can see it:** Accounting, Sales Managers, and Administrators.

This record cannot be edited or deleted by anyone, at any role, including
Administrators. It exists specifically so that nothing important can be
quietly changed or covered up after the fact.

---

## System

### Administration

The control panel for who has access, what things cost, and how the system
behaves.

**Who can use it:** Accounting and Administrators. As mentioned earlier,
Accounting holds this so account recovery never depends on a single person
— but it also means anyone with this access could, in principle, promote
themselves further, so it's held only by the two most trusted roles.

| Tab | What it's for |
| --- | --- |
| Invitations & approvals | Send an invitation to a new hire (with their role already fixed), cancel an invitation, and approve new sign-ups before they can log in. |
| Users & roles | See every staff account and change someone's role, pay type, pay rate, and whether they earn commission (so a person can be on commission, on a salary, or on both). Opening an account also shows what they have sold and to whom — the same Sales panel Payroll shows, from the same figures. Here it steps a calendar month at a time (the custom-range picker lives on Payroll), so you can look back over an account's history from the screen where you set their rate. |
| Packages & pricing | Manage the seasons, the shows, the package catalogue, and the add-on catalogue that sales are built from. Seasons are maintained here as a list ("Fall/Winter 26") so a show is picked from it rather than retyped — add one before adding the show that uses it. Renaming or removing a season only changes what the New show form offers next; shows already on the books keep the season they were created with. |
| Tax rates | Manage the tax rates applied when a sale is priced. |
| Settings | The discount threshold that triggers extra sign-off, invoice numbering, and the currency exchange rates used everywhere else in the system. |
| Configuration | System-level settings that take effect immediately, without needing a technical deployment. |

**A catalogue change never rewrites history.** If you change a package's
price or a tax rate tomorrow, every sale already made keeps the price and
rate it was actually sold at — nothing already sold is silently
recalculated. Adding a new show, package, or add-on only ever adds a new
option; it never removes or changes anyone's existing deal.

### Logs

A record of how the *console itself* is being used — sign-ins, what screens
people opened, and messaging activity. This is different from the Audit
trail: Logs is about system usage, the Audit trail is about business
decisions.

**Who can see it:** Accounting and Administrators only. This is treated as
sensitive, HR-adjacent information, so it's held to the same two roles that
hold full administrative authority.

| Tab | What it shows |
| --- | --- |
| Users | Per-person usage summary and who's currently online. |
| Activity | A stream of individual actions — one row per event. |
| Sessions | Individual sign-in sessions, with device and how long each lasted. |

---

## Console (reached from your profile menu, not the main navigation)

### Settings

Your personal preferences — currently just light/dark/system theme.
Available to everyone.

### Account

Your own profile — name, job title, phone number, department, and a profile
picture — plus your password. Available to everyone, and this is the *only*
screen where you can change your own profile.

A couple of things worth knowing:

- Fields like your role, pay rate, and commission percentage are shown here
  for reference but **cannot** be edited by you — those are set by an
  Administrator or Accounting through the Administration screen. You genuinely
  cannot give yourself a raise from this screen, even by accident.
- Changing your password signs you out of every other device you're logged
  into, except the one you're using to make the change. This is a security
  measure — if someone else had access to your account, changing your
  password locks them out immediately.

---

## Signing in and getting access

VFW Console is invite-only — you cannot sign up on your own without an
invitation code from an Administrator or Accounting.

1. You receive an invitation code with your role already assigned.
2. You sign up using that code and verify your email address with a one-time
   code sent to you.
3. An Administrator or Accounting approves your account.
4. You can now sign in.

If you forget your password, use the "forgot password" link to receive a
reset link by email. That link works exactly once and expires after a set
window — if it's already been used or has expired, you'll need to request a
new one.

---

## What you might see — known quirks

A few things you might notice while using the system that are worth
understanding, so they don't cause confusion.

**A discount percentage shown in the Approval queue can look slightly
different from the one that actually decides whether extra sign-off is
needed.** The queue's displayed number is calculated slightly differently
than the number the approval rule itself uses, so on a sale with several
add-ons the two can disagree by a percentage point or two — and the number
shown in the queue is always the *lower* of the two. If you're an approver
and a sale asks for the extra discount sign-off even though the queue showed
a percentage under the threshold, that's this quirk, not an error — trust the
number the approval screen gives you at the moment of approving, not the one
in the list.

**Some screens can show "no results" when the real problem is a connection
issue, not an empty list.** If a screen that should clearly have data (for
example, a list of sessions or a report you know has entries) shows "nothing
found," it's worth refreshing the page before assuming the data is really
gone — a small number of screens don't yet distinguish "genuinely empty"
from "the request failed."

**Some elements are hard to read in dark mode.** The active tab label on a
couple of screens (for example, the Emails screen's Sent/Received switch) can
render with very low contrast in dark mode, making it look like nothing is
selected even though it is. Switching to light mode, or simply trusting which
tab you clicked, works fine in the meantime.

**The #3 ranking badge on the Leaderboard can be hard to see in dark mode**,
for the same kind of contrast reason as above — the rank is still correct,
it's just visually faint.

---

*This manual reflects the system as of August 2026. If a screen you're using
doesn't match what's described here, check with an Administrator — the
system does evolve, and this document should be kept in step with it.*
