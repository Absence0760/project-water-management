# Legal pages: status (pre-counsel draft tracker)

The privacy notice (`/privacy`) and terms of use (`/terms`) were drafted on
2026-09-27 from what the app actually does (the privacy notice from
[security.md § Personal information (POPIA)](./security.md#personal-information-popia),
the terms in the estate's shape: the `jaredhoward` site's Terms, see
`../jaredhoward/docs/legal-status.md`). They are **not lawyer-reviewed**. This
file is internal: what the drafts assume, and what is open before the first
client goes live. Not customer-facing.

## Configuration baked into the drafts

- **Operator / responsible party for accounts:** Jared Howard, sole
  proprietor, Virginia, US. Also named as the POPIA **information officer**.
- **Contact and legal notices:** `jared@jaredhoward.com`.
- **Roles (POPIA):** the organisation using the service (WUA, consultancy)
  is the responsible party for what it puts into its projects; we are its
  operator (s20–21). Accounts are ours.
- **Hosting:** AWS `af-south-1` (Cape Town): the privacy notice says data is
  stored in South Africa. **If the deploy uses another region, change §6 of
  the notice first** (infra `aws_region` has no default on purpose).
- **Cross-border:** the operator is in the US; access from there is
  disclosed under POPIA s72.
- **Fees:** none; Terms §8 commits to notice and agreement before any fee.
- **Liability cap:** greater of 12 months' fees or US $100 (estate standard).
  Indemnity one-way (user → operator). Governing law Virginia, courts in
  Virginia, 30-day informal-resolution step, no arbitration, no class-action
  waiver; mandatory local rights (consumer, data protection) preserved.
- **Language:** English only, and English binds (Terms §17). The pages are
  not on the translation sheet; the link labels to them are.
- **Complaints:** the Information Regulator (South Africa),
  `POPIAComplaints@inforegulator.org.za` (checked 2026-09-27).

## Open before the first client goes live

- [ ] **Counsel review** of both pages: South African counsel for POPIA and
  the Consumer Protection Act's reach over a free service to SA users; US
  counsel for the Virginia terms.
- [ ] **Operator agreement** with each client (POPIA s21): a written
  agreement that we process its members' information only on its
  instructions, with security measures. **Template drafted** (2026-09-27):
  [legal/operator-agreement.md](./legal/operator-agreement.md), for counsel
  review; open until counsel has reviewed it and the first client has
  signed. Its breach clause is backed by
  [legal/incident-procedure.md](./legal/incident-procedure.md) (who decides,
  timelines, the Regulator's eServices report, notices to data subjects).
  Before the first signature, confirm the mailbox provider listed as a
  sub-processor (clause 6.1).
- [ ] **Register the information officer** with the Information Regulator
  (POPIA s55, the Regulator's eServices portal). The pack, with what to
  enter, the sources, and whether a foreign sole proprietor has to register
  at all (most likely yes, as responsible party for accounts stored in
  `af-south-1`; the questions for counsel are listed):
  [legal/information-officer.md](./legal/information-officer.md). The
  operator files it himself; record the registration number here once done.
- [ ] **Self-service deletion.** The notice promises deletion on an emailed
  request (runbook item 7 in deployment.md), which is how it works today.
- [ ] **Backups:** the notice says up to 35 days; keep
  `db_backup_retention_days` at or under that.
- [ ] **Material-change emails:** Terms §16 and Privacy §12 promise an email
  before a material change. There is no bulk "notice to all account
  holders" tool yet; send it by hand until there is.
- [x] **Consent record** (issue #48, 2026-09-27): sign-up shows "By signing
  up, you accept the Terms of use and Privacy notice" and sends the version
  it showed; the account stores it and when (`app_user.terms_version` /
  `terms_accepted_at`, 087_terms_acceptance.sql). The version is one
  constant, `LEGAL_VERSION` in `packages/engine/src/legal.ts` (the pages'
  effective date), which the pages' "Effective" line, the sign-up form and
  the API all read. A missing or stale version is refused
  (`400 terms_not_accepted`); accounts made by scripts (`seed:examples`,
  `import:project`) record nothing. Both fields are in "Download my data".
- [ ] **Asking again after a change** (follow-up to the above). `/auth/me`
  already answers `termsCurrent` (the stored version against
  `LEGAL_VERSION`), but nothing acts on it. **Before the first time
  `LEGAL_VERSION` changes**, build the re-acceptance step: signed in with
  `termsCurrent: false`, the app shows a full-page notice (what changed, links
  to both pages, **Accept** and **Sign out**) before anything else; Accept
  calls a new `POST /auth/me/accept-terms { version }`, which refuses a stale
  version like sign-up does and sets `terms_version` (the
  `app_user_terms_stamp` trigger stamps the time). Farmer-facing, so its
  words go through the translation sheet. Pair it with the material-change
  email below. Trigger: the first edit to `/terms` or `/privacy` that is
  more than a typo.

## Change log

- 2026-09-27: first drafts; linked from the landing footer, under every
  sign-in form, and in the sign-up form's own sentence.
- 2026-09-27: sign-up records which terms each account accepted (087,
  `LEGAL_VERSION`); the pages' effective line reads the same constant.
