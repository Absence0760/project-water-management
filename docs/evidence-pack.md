# Evidence packs

A licensing evidence pack is an [evidence report](./api.md#evidence-report)
frozen as a hashed, versioned, signed document that stays the same once it is
issued (roadmap
[WP-3.14](./roadmap/step-3-licensing.md#wp-314-licence-evidence-pack), issue
#71; the report's design is [design/evidence-report.md](./design/evidence-report.md)).
An applicant attaches it to a water-use licence application, and anyone
holding it can check it against the app with its short code.

This page covers what a pack holds, what its hash covers, the short code, the
lifecycle, the PDF and verification. The routes are in
[api.md § Evidence packs](./api.md#evidence-packs), the table in
[data-model.md § Evidence packs](./data-model.md#evidence-packs-112_evidence_packsql),
and the trust boundaries in [security.md § Evidence packs](./security.md#evidence-packs).

**Built so far (2026-09-30):** the table, the manifest and its hash, the pack
sign-off, drafting, issue, supersede, withdraw, delete of drafts, the public
verify lookup, and their screens: the pack's own page, its actions and
sign-off, the pack lists on the evidence report and the Applications tab and
panel, and the public verify page with its in-browser file check
([ui.md § Evidence pack](./ui.md#evidence-pack),
[§ Verify page](./ui.md#verify-page)); the server-rendered PDF
([§ The PDF](#the-pdf)). **Not built yet:** the reproduction bundle and
`reproduce:pack` (each
tracked in [followups.md § Evidence report](./followups.md#evidence-report-issue-71)).

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

The report's page 1 also shows the licence impact by year class, which the
browser builds from the two runs' daily series and the project's
year-class settings (`settings.outcomes`). A `pack-1` manifest carries
neither, so the pack's page leaves the board out and says so, rather than
show something its hash doesn't cover. Moving the board into the engine's
report, and so into the manifest, is tracked in
[followups.md § Evidence report](./followups.md#evidence-report-issue-71).

Beside the manifest, the row holds its lifecycle (status, issue stamp, reason,
successor), the report and engine versions, and room for the PDF and bundle
hashes (not built yet).

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
| | the PDF and the bundle (each will have its own SHA-256) |

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
  Re-running both runs to prove they reproduce is not done at issue: it
  takes as long as the runs; the reproduction bundle will carry it
  ([followups.md](./followups.md#evidence-report-issue-71)).
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
its scenario). Applicants (contributors) and farmers can neither read nor act
on a pack; issuing, superseding and withdrawing stay with the project's
editors (operator decision, 2026-09-29).

Each step is in the project's history: `pack.drafted`, `pack.issued`,
`pack.superseded`, `pack.withdrawn`, `pack.deleted`, and `signoff.created`
naming the pack.

## The PDF

Issuing a pack prints it (116_pack_render; the machinery is a report's,
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
4. **Recorded once.** `app_record_pack_pdf` sets `pdf_key`, `pdf_sha256` and
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

**Not in the PDF yet:** page 1's licence impact board, which the browser
builds from run series and the manifest doesn't carry
([followups.md § Evidence report](./followups.md#evidence-report-issue-71)).

## Verification

`GET /verify/:code` is public: no session. For the short code or full hash of
a pack that was issued (issued, superseded or withdrawn), it returns only what
the pack prints:

- `status`, `version`, `issuedAt`;
- `catchment` (the project's name in the manifest);
- `engineVersion`, `reportVersion`;
- `manifestSha256`, `shortCode`, `pdfSha256` (null until the PDF is
  recorded, [§ The PDF](#the-pdf));
- `successorSha256` (the hash of the version that superseded it, or null);
- `withdrawnReason` (for a withdrawn pack, else null);
- `methodology` `{ version, sha256 }`;
- `errata` `[{ id, summary }]`, as the manifest recorded them;
- `signers` `[{ fullName, registrationBody, registrationCategory,
  registrationField, registrationNo, signedAt }]`.

No ids, no inputs or results, no account, no email. A draft, a pack withdrawn
before it was issued, an unknown code and a malformed one are all `404`, the
same answer. The response isn't cached (`Cache-Control: no-store`), so a
withdrawal shows at once.

The lookup is `app_verify_pack(code)`, a `SECURITY DEFINER` function that
builds exactly that object; the route adds only `shortCode`.

**What verification proves.** That a pack with this manifest hash was issued
by this app, who signed it, and whether it still stands. To check a copy's
content, hash its manifest or its PDF (`sha256sum pack.pdf`) and compare
with the hashes verify returns. The verify page does that in the browser
([ui.md § Verify page](./ui.md#verify-page)): the file is hashed with
WebCrypto and never uploaded, and a JSON file is compared in its canonical
form too, so a manifest saved pretty-printed still matches. The pack's page
downloads the manifest as those canonical bytes, and its PDF once recorded.

## Guards

- `evidence_pack_guard` (112) keeps the manifest, its hash, the runs, the
  scenario, the version and its predecessor frozen from the insert, for every
  role, the schema owner included; the status moves only forward; the issue
  stamp is the database's; the reason, the successor, the PDF and the bundle
  are each set once (the PDF only through `app_record_pack_pdf`, the bundle
  through its future setter: `water_app` has no grant on them); the manifest must name the
  row's own id, version, project and versions; who drafted and issued it clears only when that account
  is deleted.
- `water_app` may `UPDATE` only the lifecycle columns (column grants), and
  RLS lets it delete only a draft.
- `project_pack_guard` refuses deleting a project with a pack past draft.
- `signoff_pack_draft` refuses a sign-off of a pack that isn't a draft.
- `app_record_pack_pdf` records a PDF only from its pack's running render
  job, under the key it derives, once ([§ The PDF](#the-pdf)).
- Tests: `backend/src/evidence/packs.db.test.ts` (each refusal with its
  positive control, and the PDF's lifecycle), `jobs/handlers/pack-render.test.ts`,
  `e2e/tests/evidence-pack-pdf.spec.ts` (the downloaded bytes hash to the
  recorded SHA-256), `packages/engine/src/evidence/pack.test.ts` (the
  manifest is deterministic, key order doesn't matter, a changed setting
  changes the hash, the lifecycle is outside it), the catalogue, role-ladder,
  mass-assignment and cross-project sweeps.
