# Evidence packs

A licensing evidence pack is an [evidence report](./api.md#evidence-report)
frozen as a hashed, versioned, signed document that stays the same once it is
issued (roadmap
[WP-3.14](./roadmap/step-3-licensing.md#wp-314-licence-evidence-pack), issue
#71; the report's design is [design/evidence-report.md](./design/evidence-report.md)).
An applicant attaches it to a water-use licence application, and anyone
holding it can check it against the app with its short code.

This page covers what a pack holds, what its hash covers, the short code, the
lifecycle, the PDF, verification, the reproduction bundle, sharing a
pack by link with comments on it, what an applicant reads of their own
application's packs, and the emails sent when a pack is issued or
withdrawn. The routes are in
[api.md § Evidence packs](./api.md#evidence-packs), the table in
[data-model.md § Evidence packs](./data-model.md#evidence-packs-112_evidence_packsql),
and the trust boundaries in [security.md § Evidence packs](./security.md#evidence-packs).

**Built so far (2026-09-30):** the table, the manifest and its hash, the pack
sign-off, drafting, issue, supersede, withdraw, delete of drafts, the public
verify lookup, their screens (the pack's own page, its actions and
sign-off, the pack lists on the evidence report and the Applications tab and
panel, and the public verify page with its in-browser file check
([ui.md § Evidence pack](./ui.md#evidence-pack),
[§ Verify page](./ui.md#verify-page)); the server-rendered PDF
([§ The PDF](#the-pdf)); and the reproduction bundle with
`pnpm reproduce:pack` ([§ Reproduction](#reproduction)); and share links
to an issued pack with public comments on it
([§ Sharing and comments](#sharing-and-comments), 2026-09-30); and the
applicant's own copy of their application's issued packs, with share links
([§ Applicants](#applicants), 131_applicant_packs, 2026-09-30); and the
"pack issued" and "pack withdrawn" emails to the editors and the applicant
([§ Notices](#notices), 133_pack_notices, 2026-09-30). What is left is
tracked in [followups.md § Evidence report](./followups.md#evidence-report-issue-71).

## What a pack holds

The **manifest** (engine `packages/engine/src/evidence/pack.ts`,
`buildPackManifest`, version `pack-1`):

| Field | What |
| --- | --- |
| `version` | `pack-1`: the manifest's shape |
| `pack` | `{ id, version, supersedes }`: the pack's id, its version (1 for a first pack, the predecessor's + 1 after), and the issued pack it replaces as `{ id, manifestSha256 }`, or `null` |
| `project` | `{ id, name }` when the pack was drafted |
| `engine` | `{ version, build }`: the engine that built the manifest; `build` (the git SHA) is `null` until CI records it ([followups.md](./followups.md), "ENGINE_BUILD from CI") |
| `report` | the evidence report exactly as `GET …/runs/:runId/evidence-report` serves it: identity, checks, flags, the change table, the river, uncertainty, users, the appendices (settings, model, input diff, series hashes, baseline history, warnings, other application runs) and the methodology, limitations, errata and disclaimer version |

The report goes through JSON before it is hashed, as the API serves it and
as `jsonb` stores it: a `NaN` becomes `null` and an undefined member is
dropped. So the hash taken when the draft is made is the hash of what is
stored, and the server checks that on the draft and again on issue.

The report's page 1 also shows the licence impact by year class. Since
report format `evidence-5` the engine builds its numbers into the report
(`licenceImpact`, `packages/engine/src/evidence/impact.ts`) from the two
runs' stored daily series and the project's year-class settings
(`settings.outcomes`) as they are when the draft is made, so the manifest
freezes the board and its hash covers it. A pack drafted before
`evidence-5` has no board in its manifest: its page says so rather than
show something its hash doesn't cover, and a new version carries it.
The same holds for § 1's table of the paired change in the FDC check curve
(`evidence-7`): a pack issued before it has no table, and its caption keeps
the warning that the two curve bands overlapping doesn't mean no change.

Appendix C's fixed prompts (purpose and need, mitigation, monitoring;
report format `evidence-8`, engine `evidence/prompts.ts`) are in the
report as `applicantStatement.prompts`: the scenario's answers as they are
when the draft is made, `''` for one not given. So the manifest freezes
them and its hash covers them: an applicant who changes an answer afterwards
changes the live report, never the pack (`packs.db.test.ts` pins it). No
new manifest version was needed: the manifest's shape (`pack-1`) is
unchanged, the new field is inside `report`, whose own `version` says which
format it is, and an issued pack's stored manifest (and so its hash) is
never rebuilt. A pack drafted before `evidence-8` has no prompts in its
manifest: its Appendix C says they aren't part of the pack, rather than
printing *Not given* for answers it never asked, and a new version carries
them.

Beside the manifest, the row holds its lifecycle (status, issue stamp, reason,
successor), the report and engine versions, the reproduction bundle's key and
hash (set at issue), and room for the PDF's (not built yet).

## What is hashed, and what isn't

The **manifest hash** is the SHA-256 of the manifest's RFC 8785 text
(`packManifestText`, the same canonical JSON as run inputs,
[data-model.md § Stored run inputs](./data-model.md)). The engine builds the
text; the backend hashes it with `node:crypto`, and a browser can with
WebCrypto, so the engine stays free of Node APIs.

| In the hash | Not in the hash |
| --- | --- |
| the pack's id and version, and its predecessor's id and hash | its status: draft, issued, superseded, withdrawn |
| the project's id and name at drafting | when it was drafted or issued, and by whom |
| the engine version (and build, once recorded) | the withdrawal reason and the successor |
| the whole evidence report: every setting, the model, every input series' hash, the results, the flags and checks, the methodology and errata cited | the sign-offs (each binds the hash in its own statement, below) |
| | the PDF and the reproduction bundle (each has its own SHA-256; the bundle contains the manifest) |

So a pack moves from draft to issued, superseded or withdrawn with the same
hash, and anything that changes the evidence changes it. A pack that
supersedes another names that pack's hash, so the versions form a chain.

## The short code

The first 12 hex digits of the manifest hash, as `xxxx-xxxx-xxxx`
(`packShortCode`). It is printed on the pack beside the full hash, and it is
the pack's verify link: `/verify/<short code>`. A code is looked up in any
case, with or without dashes (`parsePackCode`); the full 64-digit hash works
too. The database keeps short codes unique (a unique index on the first 12
digits), so a collision (odds about 1 in 2⁴⁸ for any pair) fails the second
draft rather than making the code ambiguous; drafting it again gives a new
pack id and a new hash.

The code is not a secret: it is printed on every page, and the verify lookup
gives back only what the pack prints.

## Lifecycle

```
draft ──issue──▶ issued ──(a new version is issued)──▶ superseded
  │                 │                                      │
  └──withdraw──▶ withdrawn ◀──────withdraw─────────────────┘
```

- **Draft.** An editor drafts a pack from an application run (a scenario
  run, reported against its base run) or from the nominated run alone
  (baseline evidence). Only a report that may be issued becomes a pack: not
  refused, and no check that blocks issue failing (the baseline is the
  current nominated run, the declared uncertainty rule is set, the cited
  ensemble and, for an application, the paired band exist, and no baseline
  assumption changed). A draft cites both runs, so they are kept.
- **Sign.** A registered professional signs the draft: the pack statement
  (`packSignoffStatement`, version `pack-signoff-1`) is the run statement's
  ten confirmations (the works one worded for the application or the
  baseline) plus an eleventh, `pack`, that names the pack's version and
  manifest hash. The errata listed are those of either run's engine, from the
  current list. As for a run, the signer sends back the statement's hash and
  the server refuses one that isn't the current statement's. Only a draft is
  signed.
- **Issue.** An editor issues a signed draft. The server checks, in one
  transaction: it is a draft; the stored manifest still hashes to its
  recorded hash; the frozen report may be issued; there is a sign-off of the
  *current* pack statement (a new known limitation or erratum since the
  signature means signing again); both runs' server stamps still match their
  rows ([security.md § Run stamps](./security.md)); and the live report may
  still be issued (the nomination, the declared rule and the cited ensemble
  haven't moved since the draft). Then it stamps the issue (`issued_at`,
  `issued_by`, set by the database, never the caller) and, for a new
  version, marks the predecessor superseded, naming the successor.
  In the same transaction it builds the pack's reproduction bundle, checks
  it, stores it and records its hash ([§ Reproduction](#reproduction)); if
  that fails, nothing is issued. Re-running both runs to prove they
  reproduce is not done at issue: it takes as long as the runs, and the
  bundle lets anyone do it (`pnpm reproduce:pack`).
- **One issued at a time.** An application (or the project's baseline
  evidence) has at most one issued pack: a second is refused at issue
  (`409`), and the database holds it at commit (`evidence_pack_one_issued`).
  The chain of versions never forks.
- **New version.** A change of evidence is a new pack that supersedes the
  issued one (`supersedesId`), for the same application (or baseline
  evidence again). The old one stays, marked superseded, and verify points to
  the new one. Nothing is edited.
- **Withdraw.** An editor withdraws a pack, with a reason (1–1 000
  characters), from any status but withdrawn. Verify then says it is
  withdrawn and why: the reason is public, so it is written for the
  authority, not the team. A signed draft that shouldn't be issued is withdrawn,
  not deleted.
- **Delete.** Only an unsigned draft is deleted. An issued (or superseded, or
  withdrawn) pack is never deleted, and a project that has one can't be
  deleted either, so its verify link keeps answering.

**Who.** Editors and owners draft, sign, issue, supersede, withdraw and
delete drafts. Viewers read packs (an application's only when they can read
its scenario). Farmers read none. Applicants (contributors) act on none:
issuing, superseding and withdrawing stay with the project's editors
(operator decision, 2026-09-29); they read their own application's issued
packs, anonymised, and link them ([§ Applicants](#applicants)). Editors
share an issued pack by link ([§ Sharing and comments](#sharing-and-comments)).

Each step is in the project's history: `pack.drafted`, `pack.issued`,
`pack.superseded`, `pack.withdrawn`, `pack.deleted`, and `signoff.created`
naming the pack.

## The PDF

Issuing a pack prints it (119_pack_render; the machinery is a report's,
[architecture.md § An evidence pack's PDF](./architecture.md#an-evidence-packs-pdf)):

1. **Queued with the issue.** `POST …/issue` queues a `pack_render` job in
   the issue's transaction, as the editor who issued, one pending per pack.
   The issue answers `pdf: { status: 'rendering' }`.
2. **Printed from the pack's own page.** The job issues a render token for
   that pack (only for a pack that was issued, which the issuer reads) and
   headless Chromium opens `/projects/:id/packs/:packId`, which draws the
   evidence report from the **frozen manifest** with the pack's stamp
   (*Issued · evidence pack version N · short code*), its verify line and its
   sign-offs. The render session reads that pack and its sign-offs and
   nothing else. The PDF shows the pack as it was when printed: a later
   supersede or withdrawal is verify's to say, not the PDF's.
3. **Stored for good, under its own hash.** The PDF's SHA-256 is its key,
   `packs/<project>/<pack>/<sha256>.pdf`, in the packs bucket, uploaded with
   that checksum so the store refuses other bytes. In production the bucket
   is versioned under an Object Lock default retention (GOVERNANCE, 10 years
   by default, no lifecycle; [deployment.md § Evidence packs](./deployment.md#evidence-packs)),
   so the object can't be deleted or overwritten by the app; locally it is
   MinIO's `water-packs`.
4. **Checked, then recorded once.** In production the renderer's answer names
   the hash; the worker first checks that the packs bucket holds an object
   under that hash's key whose stored checksum is that hash, and refuses the
   answer otherwise. `app_record_pack_pdf` sets `pdf_key`, `pdf_sha256` and
   `pdf_pages` from the render job only; the first PDF recorded stands (a
   redelivered answer or a second render changes nothing, and a second print
   is refused: `POST …/pdf` answers `409` once one is recorded). From then on
   `GET /verify/:code` returns `pdfSha256`.

**Its state** is on `GET …/packs/:packId` as `pdf`: `rendering` (queued,
running, retrying, or waiting for the production renderer's answer), `ready`,
`failed` (the render gave up, with why) or `none` (never issued). A timeout,
a WAF block or a crash is retried after 2, then 4 minutes, up to 3 renders;
after that an editor asks again with `POST …/packs/:packId/pdf`.

**The download** (`GET …/packs/:packId/pdf`, viewers of the pack) is a
`302` to a 60-second signed URL: a pre-signed MinIO GET locally, a
CloudFront signed URL on the site's `/packs/*` in production, as a report's.
The bytes downloaded are the ones hashed: `sha256sum` of the file equals
`pdfSha256` (the e2e checks exactly that).

Page 1's licence impact board prints from the manifest like the rest of
the page (a pack from before `evidence-5` prints the line saying it isn't
part of the pack).

## Verification

`GET /verify/:code` is public: no session. For the short code or full hash of
a pack that was issued (issued, superseded or withdrawn), it returns only what
the pack prints:

- `status`, `version`, `issuedAt`;
- `catchment` (the project's name in the manifest);
- `engineVersion`, `reportVersion`;
- `manifestSha256`, `shortCode`, `pdfSha256` (null until the PDF is
  recorded, [§ The PDF](#the-pdf)), `bundleSha256` (the reproduction
  bundle's, [§ Reproduction](#reproduction));
- `successorSha256` (the hash of the version that superseded it, or null);
- `withdrawnReason` (for a withdrawn pack, else null);
- `methodology` `{ version, sha256 }`;
- `errata` `[{ id, summary }]`, as the manifest recorded them;
- `errataFoundSince` `[{ id, summary }]`: errata that apply now to the
  engine of either run (or, for a `fit` erratum, of the automatic fit its
  parameters came from) and that the manifest didn't record, found since
  the pack was drafted (132). The current list
  ([engine-errata.md](./engine-errata.md), `errataFor`) over the runs'
  engines, less the recorded ids, in the list's order. The manifest, its
  hash and `errata` never change: an erratum added to engine-errata.md
  after issue shows here, apart and marked "found since issue";
- `signers` `[{ fullName, registrationBody, registrationCategory,
  registrationField, registrationNo, signedAt }]`.

No ids, no inputs or results, no account, no email. A draft, a pack withdrawn
before it was issued, an unknown code and a malformed one are all `404`, the
same answer. The response isn't cached (`Cache-Control: no-store`), so a
withdrawal shows at once.

The lookup is `app_verify_pack(code)`, a `SECURITY DEFINER` function that
builds that object, plus `runs` (132: each run's `engine_version` and its
fit's engine, `inputs.settings.fitRecord.engineVersion`, read from
`model_run`), which never leaves the API: the route maps the object field by
field (`toVerify`, backend/src/share/links.ts, the same mapping as a pack's
share link) and turns `runs` into `errataFoundSince`
(backend/src/evidence/errata.ts), and adds `shortCode`. The errata list is
the engine's (`ENGINE_ERRATA`, generated from engine-errata.md), so a new
erratum shows on verify once the API that carries it is deployed.

The pack's own page (`GET …/packs/:packId`, `errataFoundSince`) lists them
too, in its bar above the report, which is never printed: the pack and its
PDF print only what the manifest recorded. On a draft they are the errata
found since the draft was made; drafting the pack again records them.

**What verification proves.** That a pack with this manifest hash was issued
by this app, who signed it, and whether it still stands. To check a copy's
content, hash its manifest, its PDF (`sha256sum pack.pdf`) or its bundle and compare
with the hashes verify returns. The verify page does that in the browser
([ui.md § Verify page](./ui.md#verify-page)): the file is hashed with
WebCrypto and never uploaded, and a JSON file is compared in its canonical
form too, so a manifest saved pretty-printed still matches. The pack's page
downloads the manifest as those canonical bytes, and its PDF once recorded. Whether the results follow
from the inputs is the bundle's job ([§ Reproduction](#reproduction)).

## Reproduction

An issued pack has a **reproduction bundle**: a ZIP that anyone re-runs with
only the bundle and this repository at the pack's engine version, with no
database, account or network, and gets the same results (roadmap WP-3.14
item 11). The assessor gets it from the applicant (or downloads it from the
pack, `GET …/packs/:packId/bundle`, [api.md § Evidence packs](./api.md#evidence-packs))
and checks its SHA-256 against the `bundleSha256` the verify lookup returns.

**What it holds** (engine `packages/engine/src/evidence/bundle.ts`,
`buildPackBundle`, layout `bundle-1`):

| Entry | What |
| --- | --- |
| `bundle.json` | the index: the pack (id, version, manifest hash, short code), the engine, each run's id, engine and **results digest**, and the SHA-256 of every other entry |
| `manifest.json` | the manifest as its RFC 8785 text: its SHA-256 *is* the manifest hash |
| `runs/<run>/input.json` | the run's stored input snapshot (`model_run.inputs`: settings, model, each input series' first day, length and hash), `<run>` `baseline` and, for an application, `application` |
| `runs/<run>/results.json` | the run's stored summary and the SHA-256 of each daily output (results `results-1`) |
| `series/<sha256>.csv` | each input series' values, `date,value` one row a day, a missing day empty, named by the SHA-256 of the values (runs that share a series share its file) |
| `scenario.json` | the application's scenario as its run recorded it: the ops, their hash, the base run (application packs only) |
| `README.md` | how to reproduce it, and which engine to check out |

The **results digest** of a run is the SHA-256 of `runResultsText`: RFC 8785
JSON of the first day, the summary as JSON stores it, and each daily output's
node, key and values hash, sorted (labels aren't in it). Two runs with the
same digest have the same summary and the same value on every day of every
output. The bundle is deterministic: entries sorted, fixed timestamps, so the
same pack gives the same bytes on the same zlib.

**Built at issue.** The issue route (`backend/src/evidence/bundle.ts`) reads
both runs as the issuer (their stored inputs through `loadRunInput`, every
series re-hashed, and their stored daily outputs), builds the bundle, checks
it as `reproduce:pack --no-run` would, stores it in the packs bucket under
`packs/<project>/<pack>/<sha256>.zip` with its SHA-256 as the upload's
checksum (the store refuses other bytes, and the route checks the checksum
the store answers with is that one), and records it through `app_record_pack_bundle` (122), which only
the transaction that issues the pack may call. All of it or none: a bundle
that can't be stored fails the issue (`packs.db.test.ts` pins it: the pack
stays a draft, its predecessor issued, no bundle, audit row or job). The
upload comes before the commit, so an issue that fails after it leaves an
object nothing records, held by the bucket's Object Lock for the retention
period like any other: named by its own hash, it never takes the place of a
recorded one. Issuing again builds the same bytes (the build is
deterministic) under the same key; the put is conditional
(`If-None-Match: *`), so it never writes a second version, and a `412` is
taken as stored (the key is the bytes' hash, and every put under it carried
that checksum).

**Cost at issue.** Building reads both runs' stored daily outputs and hashes
each, so it grows with outputs × days. Measured 2026-09-30 on the dev laptop
at 300 outputs × 30 years a run (a large catchment), both digests took
~0.6 s and zipping the input series ~0.4 s, with ~20 MB of heap; on the API
Lambda (1 024 MB, ~0.58 vCPU, 30 s timeout) with the database read and the
check that is an estimated 5–10 s, inside the timeout. A catchment far past
that would need the build moved to a job (the durable fix in
[followups.md](./followups.md#evidence-report-issue-71)). It is built then, not on download,
because it must be what was stored when the pack was issued (a daily output
follows its node, so a later build could miss one) and its hash is published
by verify. Locally the store is MinIO (`pnpm dev:s3:up`; the backend creates
`water-packs` on first use); issuing a pack fails without it.

**Checking it.** From the repository root, at the engine the runs were made
with (the bundle's README says how to find the commit), with Node 24 and
pnpm 10:

```bash
pnpm install --frozen-lockfile
pnpm reproduce:pack path/to/pack-xxxx-xxxx-xxxx.zip [--expect <manifest hash>] [--no-run] [--json]
```

`scripts/reproduce-pack/reproduce-pack.ts` runs the engine's
`checkPackBundle` and prints each check:

| Check | Passes when |
| --- | --- |
| `archive`, `files` | the zip reads, every entry is listed in `bundle.json`, and each matches its SHA-256 there |
| `manifest` | `manifest.json` is canonical and hashes to the pack's hash (and to `--expect`, the hash verify returned) |
| `runs` | the runs are the ones the manifest names, with its engine versions |
| `inputs:<run>` | each series file parses, matches its hash and the manifest's list; the baseline's settings and model are the manifest's |
| `changes`, `scenario` | the application's inputs differ from the baseline's by exactly the changes the manifest lists, and the scenario's ops hash to the hash it names (application packs) |
| `results:<run>` | the stored summary is the manifest's, and `results.json` gives the digest `bundle.json` names |
| `reproduce:<run>` | re-running the run's input with this checkout's engine gives the same results digest (skipped with `--no-run`) |

It exits 0 when every check passes, 1 when any fails (naming what differs:
the summary's paths, the daily outputs), and 2 on a usage error. A run made
with another engine version is expected to differ: the output says which
engine to check out. Tests: `packages/engine/src/evidence/bundle.test.ts`
(round trip, determinism, and each tampering beside a positive control),
`packages/engine/src/zip/zip.test.ts`,
`scripts/reproduce-pack/reproduce-pack.test.ts` and, against the database and
MinIO, `backend/src/evidence/packs.db.test.ts` (issue, download, reproduce
both a baseline and an application pack; the setter's refusals).

## Sharing and comments

An editor shares an **issued** pack by a read-only link, so an NGO, a
catchment forum or an assessor without an account can read it during a
comment period (WP-3.15, the pack half; `128_pack_share_notes`; the token
model is a share link's, [security.md § Share links](./security.md#share-links)).
The pack's page has **Share link…** (editors, once it was issued) and
**Notes** (whoever reads it); the link opens `/share#t=…&k=pack`
([ui.md § Share page](./ui.md#share-page)).

**What the link shows** (`POST /share/pack`, `app_share_pack`): never more
than the pack itself, and never more than an application's link would.

| Always (a pack that was issued) | Only while it is `issued` |
| --- | --- |
| exactly what `GET /verify/:code` answers: status, version, issue date, catchment, engine and report versions, the manifest, PDF and bundle hashes, the successor's hash, the withdrawal reason, methodology, errata, signers | from the **frozen manifest**, never the live model: the report's title and mode, both runs' dates, engines and runoff model, the application's count of proposals and assumptions |
| its public comments, with their authors' display names | page 1's river rows (Reserve months met per site, days below the EWR, no-flow days) with their bands; each EWR site's Reserve compliance (the outlet unnamed); the paired change by calendar month |
| | the volume rows (shortfall, outflow MAR) only at 5 or more farm holders and when the report changed no baseline assumption (the share links' `k` rule) |

Never a user's, farm's or allocation's row, name or figures, the other
applications, the works below which a site sits, the settings, model, input
diff or series hashes, the applicant's statement, or any person but the
signers. The page words each row itself, by its id, in the reader's
language (the report's own labels are English).

**After the pack stops standing.** A link keeps working when its pack is
later superseded or withdrawn, and then shows the standing, the withdrawal
reason or the replacing version's code, and the comments, with **no
figure**: the same link a forum was given must never keep showing figures
the applicant has withdrawn. A new link is made only to an issued pack
(`409` otherwise). A draft never had a public page: its link can't be made,
and the read answers nothing for a pack that was never issued, as verify
does.

**Comments.** A pack note is `team` (whoever reads the pack) or
`public_participation`: any member contributor and up posts one while the
pack is issued and has a live link (`app_pack_commentable`); editors and the
comment's author always read it, other members while it is open, and once
it was shared and is superseded or withdrawn (the record of a closed
comment period). Farmers read and write none. Every edit is kept
(`note_revision`), and a pack past draft is never deleted, so the record
stays. The matrix is in [data-model.md § Notes](./data-model.md#notes-037_notessql).

**Not through a link:** the PDF, the manifest and the reproduction bundle.
They carry the whole report (every unit's figures, the applicant's
statement), which the redaction above keeps from the public; an authority
gets them from the applicant and checks them on the verify page.
**Applicants** link their own application's issued pack too
([§ Applicants](#applicants)); the link shows exactly this, whoever made it.

Tests: `backend/src/share/pack-share.db.test.ts` (who makes, lists and
revokes a pack link, each with its control; one kind only, both ways;
revoked and expired against a live token; the redaction scan against a
manifest seeded with every secret; the `k` and baseline-assumption rules;
withdrawn and superseded; the note matrix and revisions),
`share/links.test.ts` (the TypeScript allowlist against a row with planted
extras), `frontend/src/lib/components/share/pack.test.ts` and
`e2e/tests/pack-share.spec.ts` (make a link from the pack page, open it
signed out, comment, withdraw: the link says so and why).

## Applicants

An application's applicant, and whoever they shared it with
(`scenario_member`), read the packs of it that were issued, and its owner
shares them by link (WP-3.15; `131_applicant_packs`). Issuing stays with the
editors. The screens are the Application panel's pack list and the
applicant's pack view ([ui.md § Evidence pack](./ui.md#evidence-pack)); the
routes are `GET …/scenarios/:sid/packs` and `…/packs/:packId`
([api.md § Evidence packs](./api.md#evidence-packs)).

**Which packs.** Issued, superseded and withdrawn after issue, each with its
standing (a superseded one links the version that replaced it; a withdrawn
one gives the reason verify gives). Never a draft, nor a pack withdrawn
before it was issued: as verify, those never existed publicly.

**What they read: their copy, not the assessors'.** The manifest names every
hydrological unit with its figures, so an applicant never reads the pack's
row; they read a projection the database builds (D2's recommended default,
[roadmap step 3 § WP-3.3](./roadmap/step-3-licensing.md), pending the client):

| Shown | From |
| --- | --- |
| the standing, version, issue date, code, hashes, methodology, errata, signers | exactly what `GET /verify/:code` answers |
| the river's rows and EWR sites, the paired change by month, the volume rows at 5 or more farm holders | exactly what a pack link shows ([§ Sharing and comments](#sharing-and-comments)), for every standing (the applicant is the pack's party, not the public) |
| their own units: supply and reliability, baseline beside application, with the change and its band | § 4's users, for the application's owned nodes its owner still links and the nodes its proposals add |
| every other farm or water user in both runs: "Farm 3", "Water user 1", its change in share of demand supplied in whole percentage points | § 4's users, anonymised: ranked per kind in the order of a hash of the node's id, so the number says nothing of its name or place; a rank within this pack, not a label, so "Farm 3" in one version need not be "Farm 3" in the next |

No units at all when the report changed a baseline assumption (the figures
that move with it could read another unit's values out, as for the
applicant's results, 118). Never another unit's name, id, demand, volumes or
reliability, the registered volumes or holders, the other applications, the
flags and questions, the settings, model, input diff, series hashes,
warnings or the applicant statement, and no person but the signers. **Not
the PDF, the manifest or the bundle:** each carries the whole report, which
is the assessors' copy (an applicant checks any copy they are handed on the
verify page). An anonymised printable copy for the applicant is a follow-up
([followups.md § Evidence report](./followups.md#evidence-report-issue-71)).

**Share links.** The application's owner (not the consultant they shared it
with) makes a link to their own pack while it is issued, and lists and
revokes the links they made, whatever its standing; the editors still list
and revoke every link. The link shows the public projection above
([§ Sharing and comments](#sharing-and-comments)), which names no unit, the
applicant's own included.

**Why functions, not a policy.** A row policy for contributors on
`evidence_pack` would hand them the whole manifest (RLS picks rows, not
columns, and `water_app` holds table-wide `SELECT`). So the read is
`SECURITY DEFINER` functions returning an allowlist built in SQL
(`app_applicant_packs`, `app_applicant_pack_meta`, `app_applicant_pack`;
the anonymiser `app_applicant_pack_units` isn't `water_app`'s to call), and
the route maps the answer field by field again. A route that forgot to
project couldn't leak what the database never returned
([security.md § Evidence packs](./security.md#evidence-packs)).

Tests: `backend/src/evidence/applicant-packs.db.test.ts`,
`evidence/applicantPacks.test.ts`,
`frontend/src/lib/components/packs/applicantPack.test.ts` and
`e2e/tests/applicant-pack.spec.ts` (the applicant opens their issued pack
from the Application panel, sees their farm by name and the neighbour as
"Farm 1", makes a link, and it opens signed out).

## Notices

When a pack is **issued**, or one that was issued is **withdrawn**, the
project's editors and the application's owner get an email (133_pack_notices;
Mailpit locally, SES in production; `backend/src/evidence/notices.ts`). It
follows the alert mails' pattern ([architecture.md § Alert emails](./architecture.md#alert-emails)):

1. **Queued with the change.** The issue and withdraw routes call
   `app_pack_notice_queue(pack, event)` in their own transaction, as the
   editor who acted: one `pack_notice` row per recipient, so the notice
   commits with the issue or withdrawal, or neither does. The function
   refuses anyone but an editor of the pack's project, and a pack not in
   that state.
2. **Sent by the worker's tick**, after the jobs and the alert mails. Each
   email is built in a transaction *as its recipient*, under RLS: their role
   is checked again (someone removed or demoted since gets nothing), so is
   their address (confirmed, and not suppressed by SES since:
   `app_user.mail_suppressed_at`), and the catchment's and the application's
   names are read as they may read them. The mail goes out after that
   transaction; a transport failure is retried on the next ticks (3 attempts)
   and logged as `mail_send_failed` (kind `pack_notice`), which the
   `mail-send-failed` alarm counts. A worker that dies mid-send leaves the
   notice failed, never sent twice.

**Who gets it.** Everyone whose role on the project, direct or through its
team, is editor or owner (they issue and withdraw packs), and, for an
application's pack, the scenario's owner while they still hold a role above
farmer (an applicant is a contributor). Never a viewer, a farmer, another
applicant or a non-member, and never the person who issued or withdrew it:
they just did it. Once per pack, person and event (the primary key).

**Which events** (decided 2026-09-30):

| Event | Emailed? | Why |
| --- | --- | --- |
| issued | yes | the pack now stands; the email of a new version says which version it replaces |
| superseded | no email of its own | it happens in the same step as the new version's issue, whose email says so |
| withdrawn, after it was issued | yes, with the reason | the verify link the applicant may have given an authority now says withdrawn |
| withdrawn as a draft | no | a draft was never public (verify answers `404` for it) |

**What it says.** The pack's version, what it is for (the application's
name, or the baseline evidence), the catchment, the short code and the
public verify link (**Check the pack**); for a withdrawal, the reason, which
verify shows anyone already. Never a figure. Editors also get a link to the
pack's own page; an applicant doesn't, since applicants read no pack yet
([followups.md](./followups.md), "Applicants' access to their own
application's packs"): the verify link works for them. The words are in the
mail catalogue (`mail.pack.*`, `backend/src/mail/i18n/en.ts`) and follow the
recipient's language, English where a key has no translation.

There is no opt-out: like a report-ready email, it goes to the few people
who act on packs, once per issue or withdrawal. The rows are the person's
(in their data export as `packNotices`, deleted with the account) and are
purged 30 days after they are settled.

Tests: `backend/src/evidence/notices.db.test.ts` (who is queued, each
refusal with its control, the worker-only claim, each recipient's email, the
re-checks at send, a lapsed lease and the retries, the export and the purge), `evidence/packs.db.test.ts`
(the issue and withdraw routes queue them; a withdrawn draft queues none),
`mail/templates.test.ts` and `mail/outbound.security.test.ts` (the email,
against hostile names).

## Guards

- `app_record_pack_bundle` (122) is the only writer of the bundle columns:
  an editor, in the transaction that issues the pack, once, under the key it
  derives.
- `evidence_pack_guard` (112) keeps the manifest, its hash, the runs, the
  scenario, the version and its predecessor frozen from the insert, for every
  role, the schema owner included; the status moves only forward; the issue
  stamp is the database's; the reason, the successor, the PDF and the bundle
  are each set once (the PDF only through `app_record_pack_pdf`, the bundle
  only through `app_record_pack_bundle`: `water_app` has no grant on them); the manifest must name the
  row's own id, version, project and versions; who drafted and issued it clears only when that account
  is deleted.
- `water_app` may `UPDATE` only the lifecycle columns (column grants), and
  RLS lets it delete only a draft.
- `project_pack_guard` refuses deleting a project with a pack past draft.
- `signoff_pack_draft` refuses a sign-off of a pack that isn't a draft.
- `app_record_pack_pdf` records a PDF only from its pack's running render
  job, under the key it derives, once ([§ The PDF](#the-pdf)).
- Tests: `backend/src/evidence/packs.db.test.ts` (each refusal with its
  positive control, the PDF's lifecycle and the bundle's setter), `jobs/handlers/pack-render.test.ts`,
  `e2e/tests/evidence-pack-pdf.spec.ts` (the downloaded bytes hash to the
  recorded SHA-256), `packages/engine/src/evidence/pack.test.ts` (the
  manifest is deterministic, key order doesn't matter, a changed setting
  changes the hash, the lifecycle is outside it), the catalogue, role-ladder,
  mass-assignment and cross-project sweeps.
