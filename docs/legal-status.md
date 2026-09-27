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
  instructions, with security measures. security.md lists it as *(confirm)*.
- [ ] **Register the information officer** with the Information Regulator
  (POPIA s55 / the Regulator's portal).
- [ ] **Self-service deletion.** The notice promises deletion on an emailed
  request (runbook item 7 in deployment.md), which is how it works today.
- [ ] **Backups:** the notice says up to 35 days; keep
  `db_backup_retention_days` at or under that.
- [ ] **Material-change emails:** Terms §16 and Privacy §12 promise an email
  before a material change. There is no bulk "notice to all account
  holders" tool yet; send it by hand until there is.
- [ ] **Consent record:** sign-up shows "By signing up, you accept the Terms
  of use and Privacy notice", but the version accepted isn't stored per
  account. Add an `accepted_terms_at` (and version) before the terms change
  for the first time.

## Change log

- 2026-09-27: first drafts; linked from the landing footer, under every
  sign-in form, and in the sign-up form's own sentence.
