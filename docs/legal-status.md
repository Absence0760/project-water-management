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
- **Contact and legal notices:** `jared@jaredhoward.com`, **email only, no
  postal address** (the operator's decision, 2026-09-27, as on the
  `jaredhoward` site). POPIA s18(1)(a) asks for the responsible party's
  address: counsel to confirm that an email address is enough, or which
  address to publish. The Regulator's registration (information-officer
  pack) takes a postal address privately; that isn't published.
- **Roles (POPIA):** the organisation using the service (WUA, consultancy)
  is the responsible party for what it puts into its projects; we are its
  operator (s20–21). Accounts are ours.
- **Hosting:** AWS `af-south-1` (Cape Town): the privacy notice says data is
  stored in South Africa, and Terraform now enforces it: any other
  `aws_region` fails the plan unless `data_outside_south_africa = true`,
  which is only for after §6 is rewritten (infra/README.md § Region).
- **Cross-border:** the operator is in the US; access from there is
  disclosed under POPIA s72, naming the gateways relied on: s72(1)(c)/(d)
  (needed to provide the service) and s72(1)(a) (AWS's binding agreement).
  Counsel to confirm which gateway fits an operator that is itself offshore.
- **Deletion:** on emailed request, with the one exception disclosed in
  Privacy §7: an account that created project evidence is kept until the
  person and the responsible organisation agree what happens to that record
  (`docs/security.md`, the restrict foreign keys). Self-service deletion
  stays open (issue #48).
- **Assent:** "By creating an account, you agree to the Terms of use and
  Privacy notice", directly above the sign-up button (the US review: a
  notice below the button is weak evidence of assent), and the account
  records the version (087).
- **Third parties who accepted nothing:** the public share page carries the
  model-results disclaimer (not an authorisation under the National Water
  Act) and links to both pages; invitation emails link the privacy notice
  (POPIA s18, notice at collection).
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

- [ ] **Counsel review** of both pages. Two pre-counsel reviews ran on
  2026-09-27 (a US terms review and a POPIA audit, reports in `reviews/`,
  git-ignored); their fixes are in. The questions left for counsel:
  1. Does South Africa's Consumer Protection Act reach a **free** service at
     all? If not, what is the delict exposure to people who accepted no
     terms (share-link viewers, readers of a forwarded report)?
  2. Is the exclusive Virginia-courts clause enforceable against South
     African farmers and WUAs, given the savings clause for local rights?
  3. Must the s21 operator agreement and the s55 registration exist before
     the notice describes the roles (it describes them as they will be)?
  4. Is an email address enough as the responsible party's address (s18)?
  5. Should Terms §3 carry the same National Water Act citation as the
     report disclaimer (it now refers to it), and should both go through
     the disclaimer review together (docs/legal/disclaimer-review.md)?
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
