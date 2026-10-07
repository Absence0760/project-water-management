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
  hashed manifest, both for a **bounded** period, until the licence
  record's closing date (the licence's expiry, or the refusal or withdrawal,
  + 3 years; a 5-yearly review while no outcome is recorded; 161), defended under s14(1)(b) and s14(6)(b) (pre-counsel
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

**Sign-up opened 2026-10-06, before Gates A and C.** Production ran
invite-only (`signup_open = false`, [security.md § Sign-up by
invitation](./security.md#sign-up-by-invitation)) from 2026-10-05; once SES
production access was granted the operator chose to open it
(`signup_open = true`) with both gates still open, accepting that risk. Gates
A and C remain owed and should be done as soon as possible; setting
`signup_open = false` and applying closes sign-up again.

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

- [x] **HydroSHEDS end-user terms** (the River network layer, issue #345;
  [maps.md § Sources](./maps.md#sources)). HydroRIVERS' licence allows
  commercial use, and asks that end users be bound by terms at least as
  protective as its own (§ 2.1.2: never the data as a stand-alone product;
  § 2.1.3: no decompiling, reverse engineering or disassembly, a restriction
  to include in the end-user terms). The attribution half was done
  2026-10-02 (the Exhibit B statement on the public Data sources and
  credits page, `/data-sources`). *Done 2026-10-03 (the operator approved
  adding it, 2026-10-02):* Terms §9, **Map data licensed to us**, written
  for any licensed map source so later ones fit (§ Change log, 2026-10-03).
  *Open for counsel:* whether one clause in the Terms is "an end user
  license agreement … at least as protective" enough, or whether §4–§6 of
  the licence (no warranty, indemnity, liability) need mirroring in more
  words than "provided as it is, without any warranty, and not liable".
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
- [x] **Backups:** the notice says up to 35 days; keep
  `db_backup_retention_days` at or under that (and under the erasure log's
  40 days, infra/variables.tf). The one copy kept longer is the final
  snapshot a teardown takes (infra/README.md § Tearing down): since
  2026-10-02 the notice and the operator agreement (10.2) fix it at 90 days
  after the shutdown notice, then deleted. A restore re-applies the
  erasures made after its restore point (deployment.md § Restoring the
  database, step 6a).
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

### Positions taken pending counsel (2026-10-01)

Each item below is a provisional position (pre-counsel research,
2026-10-01): not legal advice, and not approved by counsel. They are built
so the app is ready for release, before the client and counsel confirm
them (issue #90; counsel review #92). The client's information officer may
override any privacy position by written instruction (operator agreement
cl. 3). The licensing ones are rows in
[roadmap/step-3-licensing.md § 11](./roadmap/step-3-licensing.md).

#### Privacy (POPIA)

- [ ] **Lawful bases** (Privacy §4, security.md § Personal information):
  *Provisional position (pre-counsel research, 2026-10-01):* accounts on
  contract (POPIA s11(1)(b)); memberships, farm links, notes, the audit
  log, sign-offs and alerts on the organisation's legitimate interest
  (s11(1)(f)), with the s11(3) objection built in (an alert's unsubscribe,
  leaving a project; Privacy §10); records kept under s14(1)(b). "And duty
  to keep" dropped: no statute requiring this record was found. Alerts are
  service messages, not direct marketing (s1, s69):
  `backend/src/mail/alerts.content.test.ts` holds their links to an
  allowlist, and SES open and click tracking stays off.
- [ ] **Deleted notes** (Privacy §7): *Provisional position (pre-counsel
  research, 2026-10-01):* the text is erased 90 days after deletion
  (158_note_purge.sql), the `note.deleted` event stays; a note on a
  scenario or pack past draft is kept hidden with the licence record
  (s14(6)(b)).
- [ ] **Backups after an erasure** (Privacy §7, operator agreement 5.8 and
  10.2): *Provisional position (pre-counsel research, 2026-10-01):*
  backups age out within 35 days; a restore re-applies every erasure and
  revocation since its restore point before traffic is back, from a 40-day
  `erasure_log` of deleted account, project and team ids
  (159_erasure_log.sql) and the audit log's revocations; the old
  instance's final snapshot is deleted within 30 days and the teardown
  snapshot 90 days after the shutdown notice.
- [ ] **The organisation's privacy contact** (Privacy §2, s18(1)(b)):
  *Provisional position (pre-counsel research, 2026-10-01):* a team names
  whom to ask about its projects' information (168); farmers see it from
  the farm menu ("Who decides about your farm's information") and
  invitation emails name it. Where none is set, operator agreement 3A.1(b)
  (the client's own notice) still covers it.
- [ ] **The audit log after an account is deleted (D12)** (security.md §
  Personal information): *Provisional position (pre-counsel research,
  2026-10-01):* pseudonymising is enough: s24(1)(b) reaches only what s14
  no longer authorises, and s14(1)(b) authorises the audit trail. The
  entries stay and are treated as personal information, not as
  de-identified; deletion now also blanks the masked address in invitation
  entries (160_pseudonymise_invites, Privacy §7). *For counsel:* whether
  the events must be de-identified instead (clearing `subject.userId` and
  node names in events about the person).
- [ ] **The life of the licence record** (Privacy §7, evidence-pack.md §
  Retention): *Provisional position (pre-counsel research, 2026-10-01):* a
  date the project holds (161_licence_record): the licence's expiry, or
  the refusal or withdrawal, + 3 years (Prescription Act s11(d), s12(3);
  PAJA; NWA s28(1)(e)), with a 5-yearly review while no outcome is
  recorded (NWA s28(1)(f)'s interval). The tick emails the owners and the
  operator; it never deletes: the operator deletes on the client's written
  confirmation (deployment.md runbook item 16). A pack's signer is told so
  before signing (the dialog's note, not part of the hashed statement, so
  no sign-off version change). *For counsel:* whether 3 years is the right
  tail.
- [ ] **Public bodies' records** (operator agreement 3A.2): *Provisional
  position (pre-counsel research, 2026-10-01):* a team the operator marks
  `team.public_records` (a DWS or CMA client, National Archives and
  Records Service Act s13(2)(a)) keeps its members' names in its projects'
  history after account deletion, and is kept until the client confirms
  disposal (161). Privacy §7's sentence for such a team, with its own
  `LEGAL_VERSION` bump, waits for the first such client (followups.md).
  *For counsel:* whether the Act applies to a CMA's or DWS's use of the
  app.

#### Licensing

- [ ] **D1, who hosts the baseline / who decides.** *Provisional position
  (pre-counsel research, 2026-10-01):* the National Water Act fixes who
  decides a licence (the responsible authority: DWS, or a CMA the power is
  assigned or delegated to; s1, s40(1), s41, s42) and whose evidence it
  accepts (s41(2)), not who hosts the model. *Built
  (163_licensing_authority):* each project names its responsible
  authority; only members the owner marks as acting for it record its
  decision or endorse a published baseline; packs print whom they are for
  and whether the baseline was endorsed; a database conflict guard keeps
  editors out of applying parties, so a consultancy host can't also act
  for applicants. *For counsel:* whether a WUA or consultancy host changes
  the POPIA responsible party and the PAIA regime (a CMA, and probably a
  WUA, is a public body), and whether a marked member's endorsement can
  stand for the authority's acceptance of evidence under s41(2).
- [ ] **D2, what an applicant sees, and freezing "own".** *Provisional
  position (pre-counsel research, 2026-10-01):* keep the farmer scope plus
  the river (other farms' figures are personal or commercial information,
  POPIA s1, PAIA s36/s64; fairness to the applicant is the authority's
  duty, PAJA s3, s5). An issued pack's applicant copy keeps the units it
  was issued about: the right of access attaches to the application, not
  to who holds the land now (PAIA s50(1)(a)). *Built
  (164_applicant_visibility):* the copy reads the units the frozen report
  counted as the applicant's, within the application's stored own nodes,
  never the owner's current links. *For counsel:* whether figures about
  land the applicant no longer holds now relate to the new holder.
- [ ] **The k rule on catchment series.** *Provisional position
  (pre-counsel research, 2026-10-01):* natural flow (and the EWR made from
  it) describes the river, not anyone's use, so it shows at any holder
  count; the series from which "natural minus outflow = the farms' use"
  follows keep k ≥ 5 (a judgement in line with statistical-disclosure
  practice, not a statutory number). *Built (164):* share links and
  applicants see natural flow and the EWR always; outflow, observed flow
  below the farms, the EWR shortfall and the volume rows stay at five
  holders. A dominance rule (one holder taking most of the use) is a
  tracked follow-up. *For counsel:* whether 5 is defensible, and whether a
  dominance rule is needed before go-live.
- [ ] **Rules broken by hidden farms.** *Provisional position (pre-counsel
  research, 2026-10-01):* a validation refusal the applicant can't fix
  blind is a fairness problem; an aggregate over five or more holders
  relates to no one of them (POPIA s1). The authority, not the operator,
  decides what its reasons disclose (NWA s42(b), PAJA s5). *Built (164):*
  the catchment's aggregate past five hidden holders, the generic words
  below; the assessors read the rule's real words; the applicant's **Ask
  the assessors why** sends the line, the changes it names and the rule's
  kind (nothing hidden), and an editor answers once. *For counsel:* how
  much third-party detail the authority's reasons may carry (PAJA s5(4)).
- [ ] **The applicant's printable copy, and the full pack to the
  authority.** *Provisional position (pre-counsel research, 2026-10-01):*
  the applicant files the technical report (R267 reg 11(1)) and what they
  file reaches the public (Annexure D item 8), so the copy they file
  withholds other users' figures, close to what PAIA severance would give;
  the full pack goes where s41(2) says the evidence goes. *Built
  (165_applicant_copy):* a party's printable copy of an issued pack,
  printed as them, saying it is a derived copy and where to check the
  pack, with its own hash; an editor sends the full pack to the members
  acting for the responsible authority (a link to sign in to, never a
  file). Sending to an outside address is a tracked follow-up. *For
  counsel:* whether the copy needs the third parties' notice at all, and
  whether delivery to an authority inbox outside the app is needed.
- [ ] **D3, registered volumes and names** (allocations.md § Who sees
  what): *Provisional position (pre-counsel research, 2026-10-01):*
  registered users' names never go to viewers or public pages (editors,
  owners and the linked farmer only); viewers see per-farm volumes only
  when an owner allows it, else totals at 5 or more holders
  (162_allocation_viewer_units); § 5 of an issued pack lists only the
  applicant's own units, the rest as totals (report format `evidence-15`);
  a WARMS extract records how it was obtained (operator agreement
  3A.1(d)). *For counsel:* the WARMS data terms, and whether 5 holders is
  enough.
- [ ] **D5, public participation (item 7).** *Provisional position
  (pre-counsel research, 2026-10-01):* only someone who timeously lodged a
  written objection may appeal (NWA s148(1)(f)) and is told of the
  decision (s42(a)); the objection goes to the notice's address (R267 reg
  17(4)(b)(vii)); the applicant keeps the I&AP register and compiles the
  participation report (regs 18–19). *Built (166_public_participation):*
  every public comment box and share page says a comment is not a written
  objection and prints the notice's address and closing date when the
  applicant gives them; anyone signed in comments through a live link with
  no project role (an NGO is never a viewer); the applicant and the
  assessors download the reg 19 record (CSV and a print page under
  Annexure D item 8's headings), with a commenter's email only where they
  ticked the reg 18 box, with the POPIA s18 notice at the box and Privacy
  §5. *For counsel:* whether the warning's words are enough to protect an
  NGO's standing, whether the operator or the host is the responsible
  party for the emails handed to the applicant, and whether the record
  meets reg 19(1)(a) as a submission.
- [ ] **D14, the outcome words.** *Provisional position (pre-counsel
  research, 2026-10-01):* "approved with conditions" has no meaning of its
  own (every licence carries conditions, s28(1)(d)), and no app user
  decides. *Built (163):* the outcomes are *Licence issued (see its
  conditions)*, *Licence refused*, *Application rejected (formal
  requirements)* and *Not considered: use already authorised*; the action
  is **Record the authority's decision**, with the authority's name, the
  decision letter's date, its reference and whether written reasons were
  received; the app says appeals run from the decision letter and computes
  no deadline. Older decisions were mapped. *For counsel and the pilot
  authority:* the exact labels (its house style), and whether the R267
  "rejection" stages need their own record.
- [ ] **D15, the impact basis.** *Provisional position (pre-counsel
  research, 2026-10-01):* report both, labelled, with full authorised use
  as the headline (s27(1)(a), (f), s29(1)(a)(iii); R267 "existing and
  potential impacts"), and the authorised volume's mix, since only a
  licence or verified existing lawful use is an entitlement. *Built (165,
  report format `evidence-14`):* both boards on page 1; an editor runs the
  full-allocation pair; a fixed row says when there is none. *For counsel
  and the client's hydrologist:* which basis an authority expects first,
  and how to treat registered but unverified volumes.
- [ ] **D16, signers (item 9).** *Provisional position (pre-counsel
  research, 2026-10-01):* neither the NWA nor R267 requires a registered
  signer, but consulting for a fee is practising (NSP Act s20(1)); the
  evidence is the applicant's (s41(2)(a)(ii)). *Built (167_signers):* the
  applicant's appointed specialist signs (`specialist`), an editor may add
  a `review`; a sign-off, issue and withdrawal need a code from the
  authenticator within 10 minutes; the host (an owner, or a member acting
  for the authority) records its check of the signer's registration
  against the public register, which verify then shows ("checked … by
  <org>, <date>", else "self-declared"), and issue waits for it while the
  project requires it (on by default); the dialog and Terms §3 say an
  in-app sign-off is not the signature the authority requires (ECTA
  s13(1)). *For counsel:* whether the sign-off wording is a material Terms
  change; whether the host's recorded check creates any assurance by the
  operator; whether an integrated (NEMA) application's
  SACNASP-registration protocol (GN 320 of 2020) changes the product rule.

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
- 2026-10-01: Privacy §3, §4, §5 and §7 (issue #74, 151): the "Was this
  useful?" link on alert emails. §3 lists the feedback kept (yes or no, an
  optional comment, the alert's kind; nothing until Send is pressed) and
  says the emails carry no tracking pixels or tracked links; §4 adds its
  lawful basis (the organisation's legitimate interest in useful alerts;
  answering is optional); §5 says editors see the answers counted and the
  comments without names; §7 gives its retention (an answer 1 year; an
  unanswered link 30 days). A new kind of personal information, so a
  material change: `LEGAL_VERSION` 2026-10-01 (every account accepts again;
  nothing is in production yet).
- 2026-10-02: Terms §9 links the new Data sources and credits page
  (`/data-sources`: each third-party dataset's licence and the credit it
  asks for). A pointer to a notice, not a change to anyone's rights or
  duties: a clarification, so no `LEGAL_VERSION` bump.
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
- 2026-10-01: provisional positions (pre-counsel research, 2026-10-01; not
  legal advice, counsel review #92) on issue #90's D12, evidence that names
  its maker, and D3 (§ Positions taken pending counsel):
  **D12**: pseudonymising the audit log is enough (s24(1)(b) reaches only
  what s14 no longer authorises; s14(1)(b) authorises the trail), the
  entries are treated as personal information, and deletion now also
  blanks the masked address in invitation entries (160).
  **Licence record**: "the life of the licence record" is a date the
  project holds (161): the licence's expiry, or the refusal or withdrawal,
  + 3 years, with a 5-yearly review while no outcome is recorded; the tick
  emails the owners and the operator, the operator deletes on the client's
  written confirmation (deployment.md runbook item 16); the pack signer is
  told so (the dialog's note, not part of the hashed statement, so no
  sign-off version change). A DWS or CMA client may be marked
  `team.public_records` (operator agreement 3A.2), keeping names in its
  project history; its Privacy §7 sentence waits for such a client.
  **D3**: registered users' names never go to viewers or public pages;
  viewers see per-farm volumes only when an owner allows it, else totals at
  5 or more holders (162); § 5 of an issued pack lists only the applicant's
  own units (`evidence-15`); a WARMS extract records how it was obtained
  (operator agreement 3A.1(d)). Privacy §5 and §7 changed; the round's one
  `LEGAL_VERSION` bump carries them.
- 2026-10-02: the POPIA positions taken pending counsel (provisional
  positions, pre-counsel research, 2026-10-01; not legal advice). Privacy
  §4 names each lawful basis (accounts on contract, s11(1)(b); project
  data and alerts on the organisation's legitimate interest, s11(1)(f);
  "and duty to keep" dropped) and says alerts are service messages that
  never advertise; §10 says how to object (an alert's unsubscribe, leaving
  a project, or telling us or the organisation); §2 points to the
  organisation's privacy contact on the farm page and in invitations
  (168); §7 says a deleted note's
  text is erased after 90 days (158), that a restore deletes again what was
  deleted after the backup (a 40-day list of deleted accounts and projects,
  159), and that the teardown copy is kept 90 days. Other changes in the
  same round share this version: history, licence records and registered
  water use (above); Privacy §3 and §5 on public comments (the applicant
  receives a comment, its display name and date for the reg 19 report, and
  the email only with the reg 18 register box ticked; commenting through a
  link needs no project role, 166) and the host's record of a registration
  check (167); Terms §3 says an in-app sign-off is not the signature the
  authority requires and needs a fresh authenticator code (167). `LEGAL_VERSION` 2026-10-02 (a new date, since the 2026-10-01
  version had already been bumped that day; every account accepts again,
  and nothing is in production yet); the re-acceptance notice's "what
  changed" list is rewritten for it.
- 2026-10-03: Terms §9 gains **Map data licensed to us** (pre-counsel
  wording, not legal advice; the operator approved adding it on
  2026-10-02): map data licensed to us by others (HydroRIVERS, from WWF's
  HydroSHEDS, first) may be used within the service and as part of a
  user's projects, results, reports and maps, but not copied, extracted or
  distributed on its own as a stand-alone dataset, and not decompiled,
  reverse engineered or disassembled; it stays its licensors' property,
  as it is, with no warranty and no liability from them. §11's survival
  list adds §9. This is what the HydroSHEDS licence's § 2.1.2 and § 2.1.3
  ask of end-user terms (read from its technical documentation v1.4,
  Appendix A, 2026-10-02). New duties on users, so a material change:
  `LEGAL_VERSION` 2026-10-03 (a new date, since 2026-10-02's version was
  already set; every account accepts again, and nothing is in production
  yet). The re-acceptance notice's "what changed" list gains its line (one
  line, translated); since round 4 (2026-10-02) the list keeps every
  version's lines and shows those after the version the account accepted
  (`termsVersion` on `/auth/me`; all of them for an account that accepted
  none), so the 2026-10-02 lines are still shown to anyone who accepted
  before them. The rivers load gate
  (`scripts/release/map-data-gates.mjs`) now checks for the clause as well
  as the Exhibit B statement.
