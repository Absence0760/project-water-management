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
- **Contact and legal notices:** `jared@jaredhoward.com`, **email only for
  now**. POPIA s18(1)(b) asks for the responsible party's "name and
  address", and research (Q4 below) says an email address alone probably
  isn't enough. The operator will get a business address (not his home) and
  publish it in Privacy §1 and §13 and Terms §19 (Gate C). Until then the
  pages give email only; no address is invented. The Regulator's
  registration takes the same address.
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
- **Deletion:** on a request by email or any other expedient way (POPIA
  s24, Regulation 3 as amended: Form 2 in any expedient manner, free), acted
  on as soon as reasonably practicable and answered with what was done
  (s24(4); runbook item 7 in deployment.md). Privacy §7's rule (138, issue
  #112): **keep the evidence, remove the name**. What the person made for a
  project stays with their name removed, never reassigned to a colleague
  (that would make the record false, s16); a started ensemble and a draft
  application go with the account. Two things keep the name: a sign-off's
  typed name and registration and the names printed in an evidence pack's
  hashed manifest, both for a **bounded** period, the life of the licence
  record they support, defended under s14(1)(b) and s14(6)(b) (pre-counsel
  research, fact-check of 2026-09-30 on #112). The only refusal left is the
  only owner of a project or admin of a team, until it is handed over.
  Self-service deletion (Account → Delete my account, 143, #112) is the
  convenience on top; POPIA doesn't require it. It runs the same deletion
  and emails the person what was done.
- **Assent:** directly above the sign-up button, a box with the four main
  points of the Terms in the reader's language ("The main things you agree
  to", `lib/components/legal/termsSummary.ts`; the same points open the
  Terms as "The short version"), then a required, unticked checkbox: "I have
  read the main points above and accept the Terms of use and Privacy
  notice". The account records the version (087). Since issue #162 the
  points are in their own scroll box, so the form fits a laptop's window:
  the heading, **Read the full terms** and the first lines always show, the
  whole list whenever the window has room, a fade marks more below, and the
  box scrolls with the keyboard ([ui.md § Sign-up assent](./ui.md)). Before,
  the box stood at full height and the page scrolled. Whether a scroll box
  is as good evidence of assent as the full-height box is a question for
  counsel (below); the box still sits between the fields and the tick, and
  the tick still says the main points were read.
- **Third parties who accepted nothing:** the public share page carries the
  model-results disclaimer (not an authorisation under the National Water
  Act) and links to both pages; invitation emails link the privacy notice
  (POPIA s18, notice at collection).
- **Fees:** none; Terms §8 commits to notice and agreement before any fee.
- **Liability cap:** greater of 12 months' fees or US $100 (estate standard),
  §12–13 in bold sentence case (not capitals). Indemnity one-way (user →
  operator).
- **Governing law (Terms §15), per user** (the operator's decision,
  2026-09-28): anyone who lives in South Africa, or uses the service for a
  farm, WUA, business or organisation based there, gets South African law
  and the non-exclusive jurisdiction of the South African courts (with
  consent to the magistrates' courts); everyone else Virginia law and
  courts, and a consumer may also sue where they live. 30-day
  informal-resolution step, no arbitration, no class-action waiver, no
  shortened claim period (the one-year limit was dropped: the Prescription
  Act applies); mandatory local rights (CPA, ECTA, POPIA) preserved for all.
  The operator agreement (§13.3) is South African law.
- **Language:** English only, and English binds (Terms §17). The pages are
  not on the translation sheet; the link labels to them, the sign-up
  summary of the main points and the re-acceptance notice are.
- **Complaints:** the Information Regulator (South Africa),
  `POPIAComplaints@inforegulator.org.za` (checked 2026-09-27).

## Open before the first client goes live

- [ ] **Counsel review.** No counsel has reviewed the pages. The operator
  accepts research-based wording himself, as operator. The five questions
  below were researched on 2026-09-28 by pre-counsel research agents
  (reports held by the operator; **not legal advice**):
  1. **CPA and delict.** *Research:* probably no CPA "transaction" while the
     service is free, but a WUA's supply of the farm view to its members is
     probably a deemed one (s5(6)(a)), and a one-line assent likely fails
     s49's "fact, nature and effect" test. Delict is the real exposure, and
     it is small once the notices sit with the figures. *Done:* the main-points
     summary and required checkbox at sign-up, "The short version" at the
     top of the Terms, §12–13 out of capitals, the Terms §3 duty to pass
     reports on whole, and the re-acceptance step. *Open for counsel:*
     whether the summary in a scroll box (issue #162, so the sign-up form
     fits the window) draws attention to the terms as well as the
     full-height box did (s49(3)–(4)).
  2. **Virginia courts.** *Research:* not durable against South African
     farmers (a South African court keeps its discretion, and the CPA and
     ECTA can't be contracted out of). *Done:* §15 per user, as above.
  3. **s21 agreement and s55 registration before the notice.** *Research:*
     the notice may come first; registration must precede the first
     production sign-up, and a signed s21 agreement must precede a client's
     members' data. *Done:* Gates A and B below, a Privacy §2 sentence on the
     written agreement, and a "Client's duties" clause (3A) in the operator
     agreement.
  4. **Email as the s18 address.** *Research:* probably not enough;
     publish a business street and postal address. *Done:* Gate C below.
  5. **The liability wording (#47).** *Research:* the disclaimer's
     non-assumption sentence is the right formula, but it must travel with
     the figures, and physical harm (possibly CPA s61) and known defects
     aren't covered by any wording. *Done:* the Terms §3 duty above; the
     rest is in [legal/disclaimer-review.md § 6](./legal/disclaimer-review.md#6-still-for-a-lawyer)
     and Gate D.

### Go-live gates, in order

Tracked in issue #103.

- [ ] **Gate A: register the information officer** with the Information
  Regulator (POPIA s55) **before the first production sign-up**. Pack:
  [legal/information-officer.md](./legal/information-officer.md). The
  operator files it himself; record the registration number here.
- [ ] **Gate B: a signed s21 operator agreement** with each client **before
  that client's members' data goes in** (a farmer invitation, a farm link,
  a WARMS import, a named sign-off). Template: the operator agreement item
  below.
- [ ] **Gate C: a business address published** (not the operator's home) in
  Privacy §1 and §13 and Terms §19, and on the Regulator's registration,
  **before the first production sign-up**. A contact addition, not a
  material change: no `LEGAL_VERSION` bump.
- [ ] **Gate D: before the first fee.**
  - A client service agreement beside the operator agreement: confirms the
    Terms' risk allocation, makes the client responsible for how it
    publishes and shares results, an indemnity for third-party claims from
    what it published (never from individual farmers), and professional
    indemnity cover for consultants who sign off.
  - Technology errors-and-omissions insurance that covers claims brought in
    South Africa, under South African law, by third parties too.
  - [x] A known-defect procedure beside the incident procedure: when an engine
    bug that changes results is confirmed, flag the affected runs and email
    the project owners. *Done (2026-10-01, issue #103):*
    [legal/known-defect-procedure.md](./legal/known-defect-procedure.md),
    for counsel review. A row in engine-errata.md is the trigger: the app
    tags the runs it may affect (**May be affected**) and the worker emails each
    affected project's owners once (153_erratum_notices).
  - A South African attorney's opinion on the CPA once fees start (s48, s49,
    s51, and whether s61 reaches a hosted model), the US $100 floor against
    real fees, §16 and §18 against s48, ECTA s43–44 (address, cooling-off),
    and the s54 quality right.
  - Jurisdiction and enforcement against a US sole proprietor.
  - Whether English-only Terms bind Afrikaans-reading farmers (the summary
    at sign-up is translated; the Terms are not).

### Other open items

- [ ] **Operator agreement** with each client (POPIA s21): a written
  agreement that we process its members' information only on its
  instructions, with security measures. **Template drafted** (2026-09-27):
  [legal/operator-agreement.md](./legal/operator-agreement.md), for counsel
  review; South African law (§13.3) and a "Client's duties" clause (3A:
  lawful basis, the client's own s18 notice, the s57–58 question for WARMS
  matching) added 2026-09-28. Open until the first client has signed. Its breach clause is backed by
  [legal/incident-procedure.md](./legal/incident-procedure.md) (who decides,
  timelines, the Regulator's eServices report, notices to data subjects).
  Before the first signature, confirm the mailbox provider listed as a
  sub-processor (clause 6.1).
- [ ] **Self-service deletion.** The notice promises deletion on an emailed
  request (runbook item 7 in deployment.md), which is how it works today
  for every account since 138. The Account page's **Delete my account** is
  a convenience still to build (#112). Counsel to confirm the rule (keep the
  evidence, remove the name), the bounded retention of sign-offs and pack
  names, and the National Archives Act question for a responsible party
  that is DWS or a CMA (operator agreement, notes for counsel).
- [ ] **Backups:** the notice says up to 35 days; keep
  `db_backup_retention_days` at or under that. The one copy kept longer is
  the final snapshot a teardown takes (infra/README.md § Tearing down); the
  notice says it is kept until deleted, and that the shutdown notice will
  give its period. Decide that period when shutting down, and delete it on
  time.
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
- [x] **Asking again after a change** (2026-09-28, with the first
  `LEGAL_VERSION` change, to `2026-09-28`). Signed in with `termsCurrent:
  false` (an older version, or none: accounts made by `seed:examples` and
  `import:project` accepted nothing), every app page shows a full-page
  notice instead (`auth-extras/TermsUpdate.svelte`, from the root layout):
  what changed, links to both pages, the same main points as sign-up,
  **Accept the new terms** and **Sign out**. The public pages (the legal
  pages, emailed links, share links) stay open. Accept calls `POST
  /auth/me/accept-terms { version }`, which refuses a stale version
  (`400 terms_not_accepted`) and sets `terms_version`
  (`app_user_terms_stamp` stamps the time). Translated. The notice's "what
  changed" list is rewritten with each new version. Only the app is gated;
  the API doesn't refuse other calls from such an account.

## Change log

- 2026-09-27: first drafts; linked from the landing footer, under every
  sign-in form, and in the sign-up form's own sentence.
- 2026-09-27: sign-up records which terms each account accepted (087,
  `LEGAL_VERSION`); the pages' effective line reads the same constant.
- 2026-09-28: Terms §15 per user (South African law and courts for South
  African users), the one-year claim limit dropped, "The short version" at
  the top, §12–13 in sentence case, the §3 duty to pass reports on whole;
  Privacy §2 names the s21 agreement. `LEGAL_VERSION` 2026-09-28, with the
  re-acceptance step and the sign-up summary and checkbox. Counsel list
  replaced by the research positions and Gates A–D.
- 2026-09-29: Privacy (retention) says a project that has put a run
  forward as evidence or issued a licensing evidence pack can't be deleted
  and is kept as that licence record (035, 112; operator decision on packs).
  It states what was already the case for nominations: a clarification, not
  a material change, so no `LEGAL_VERSION` bump.
- 2026-09-30: Privacy §5 (who can see it) says what a share link opens now
  (a catchment's published results, a submitted application (115) or an
  issued evidence pack (128)) and the two things those pages name: a public
  comment's author (115, 128) and a pack's signers (as verify already
  shows, 112). It states what the app already did: a clarification, not a
  material change, so no `LEGAL_VERSION` bump.
- 2026-09-30: Privacy §7 rewritten (issue #112, 138): the "one exception"
  (an account that made evidence kept until the person and the organisation
  agree, possibly "handing it to a colleague") is gone. Deletion keeps the
  evidence without the name, deletes a started ensemble and a draft
  application, keeps a sign-off's typed name and the names printed in an
  evidence pack for the life of the licence record, and asks the only owner
  or admin to hand over first; a project kept as a licence record is kept
  for the life of that record, then deleted. Privacy §10: a deletion request
  in any expedient way, answered as soon as reasonably practicable with what
  was done. A material change: `LEGAL_VERSION` 2026-09-30 (every account
  accepts again; nothing is in production yet).
- 2026-10-01: Privacy §10 says a signed-in person can delete the account
  themselves (Account → Delete my account, issue #112, 143), and §7 that the
  account page says when they must hand a project or team over first. The
  right, what deletion does and the answer (an email of what was done) are
  unchanged: a clarification, not a material change, so it brings no
  `LEGAL_VERSION` bump of its own (it shares the 2026-10-01 text with any
  bump made that day).
- 2026-10-01: two-step sign-in (issue #282, 150_mfa.sql). Privacy §3 lists
  the authenticator key (stored encrypted), the recovery codes (one-way
  hashes), wrong-code counts and the account's own record of turning it on
  or off; §7 their retention; §8 a third strictly necessary cookie,
  `wm_mfa` (the 5-minute sign-in challenge between the password and the
  code); §9 says owners, team admins and assessors must use it. New
  personal data kept: `LEGAL_VERSION` 2026-10-01. The re-acceptance
  notice's "what changed" list now names this and the 2026-09-30 deletion
  change (it still listed 2026-09-28's).
