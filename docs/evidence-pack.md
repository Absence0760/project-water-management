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
([§ Notices](#notices), 133_pack_notices, 2026-09-30); the server's
re-run of both runs from the stored bundle after issue, shown on the pack's
page ([§ Reproduction](#reproduction), 154_pack_reproduce, 2026-10-01); and § 1's site
locality map, frozen with its SVG's hash ([§ The locality map](#the-locality-map),
report format `evidence-12`, 2026-10-01). What is left is
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

§ 6, the applicant's demand objects with their sources (report format
`evidence-9`, issue #259), is `report.demandObjects`: each object on the
applicant's units with its sizing, source, note and each run's demand, and
the share of that demand by source, read from the two runs' stored inputs
and summaries when the draft is made. So the manifest freezes it and its
hash covers it, and no manifest version changed, as for `evidence-8`. A
pack drafted before `evidence-9` has no `demandObjects` in its manifest:
its stored manifest still hashes to its recorded hash (nothing rebuilds
it; `packs.db.test.ts` pins one), and its report prints without § 6,
exactly as it did.

§ 1's locality map (report format `evidence-12`, issue #326 A5) is
`report.localityMap`: the map features the figure draws and its SVG's
SHA-256, read when the draft is made, so the manifest freezes the figure
and its hash covers it ([§ The locality map](#the-locality-map)). No
manifest version changed, as for `evidence-8`. A pack drafted before it has
no `localityMap`: its stored manifest still hashes to its recorded hash
(`packs.db.test.ts` pins one), and its § 1 says the locality map isn't part
of the pack.

Beside the manifest, the row holds its lifecycle (status, issue stamp, reason,
successor), the report and engine versions, the reproduction bundle's key and
hash (set at issue), and room for the PDF's (not built yet).

## What stops issue on the river

Report format `evidence-10` (issue #54, #90 Q15 and Q16) adds two checks
that stop issue (`blocksIssue`, never `refuses`: the report still previews,
with each failing check, its detail naming the units, and its fix under
*Expect questions about*). Both read the runs' **stored models**
(`inputs.model`), not the live project, so they judge exactly what the pack
cites; engine `evidence/riverWorks.ts`, called by `evidenceChecks`.
Exploring stays unrestricted: a model with an uncapped pump or no hands-off
flow still saves and runs (a farm's uncapped river pump and a dam-less unit's
route past its pump are warned about in the run), only a pack can't be
issued on it.

- **`pumpCapacity`: every river pump has a capacity**, in the baseline and,
  for an application, the application run too (baseline evidence included).
  It fails on any of these, each named in the detail:
  - a unit whose supply rule pumps from the river (river first, trigger, run
    of river) for demand (a crop area or an enabled demand object) with no
    pump capacity: `null`, or a value the run reads as no limit; 0 means no
    river pump (model.md §2.7e);
  - a unit with no dam, under any supply rule but run of river, whose dam
    split routes the upstream river or its own runoff to its demand: the run
    irrigates that straight from the river, past any pump and its capacity
    (model.md §2.7e, §2.7h). "No dam" is read over the run's own days
    (§2.7g): a dam not yet in service when the run starts, or silted empty by
    its end, leaves days without one;
  - an other water user with demand and no pump capacity (model.md §2.7c);
  - a river off-take whose rate isn't a number and has no daily cap. Its
    capacity is the month's rate × 86 400, capped by the daily cap (§2.6a),
    so a stored off-take normally passes.

  River to dam always has its capacity. A unit whose abstraction starts after
  the run ends (§2.7g) takes nothing in it. Without a cap, only the river's
  flow limits the take, which is no basis for licensing a volume. The fix
  names what to enter for each kind (a pump capacity under Network › the
  unit › Supply, run of river for a dam-less unit, the user's pump capacity,
  the off-take's rate), then run the model again and nominate that run (or,
  for the application's own units only, run the application again).
- **`protectsEwr`: the application's own river abstraction leaves the EWR in
  the river** (applications only). The ops the scenario classifies as
  proposals ([scenarios.md](./scenarios.md)) that add, change or may raise
  a unit's or an off-take's take (a new unit, any field of the applicant's
  unit but its name, its crop areas or demand objects, a crop the scenario
  added, demand raised on it, its abstraction point moved, a borehole or a
  dam transfer into it removed, its registered volume set or removed, an
  off-take added or changed) name the river
  abstractions to judge, as the application ran them: a river pump, River
  to dam, a dam-less unit's take, an off-take, an other water user. Each
  must leave the EWR, or a set flow, in the river in **every month it can
  take**: the EWR kept (`handsOffEwr`), or a hands-off flow above 0 in each
  of those months (all twelve for a pump, the months River to dam runs for
  River to dam). A farm's binds its pump and River to dam (model.md §2.7h),
  an off-take's (one value for every month) its own take (§2.6a), and a
  pass-inflow dam release counts for the river pump, which keeps the
  release's target (§2.7e). An other water user can't keep one in the
  model, so the fix says to model the new take as a unit that pumps from
  the river. Under the NWA the Reserve comes first and a new licence
  normally carries a hands-off condition.

**Decided, pending the hydrologist** (#90 Q15 and Q16 recommended requiring
both for licensing; this is built on that recommendation):

- *The baseline's users are not judged by `protectsEwr`.* The baseline
  represents current use, and modelling a protection existing users may not
  honour would misstate the river the application is measured against. Q15's
  recommendation reads wider ("required on any project used for a licence
  application"); the narrower rule keeps the baseline honest, and an op on
  another's unit is a baseline assumption, which the `assumptions` check
  already stops.
- *A hands-off flow must cover every month the works take*, not only some:
  one month's leaves the rest of the year unprotected.
- *Over-inclusion is on the safe side.* Any change to the applicant's unit
  (its dam, its crops, its efficiency) puts its river take under the check,
  since a licence for the unit would carry the condition; a pump on a unit
  with no demand takes nothing and isn't named.

Not covered: water an on-channel dam catches (the upstream-to-dam share into
a dam that is there) isn't an abstraction a hands-off flow binds (model.md
§2.7h); passing inflow through a dam is a release rule. A borehole's stream
depletion is a lagged share of what it pumps (§2.7d), bounded by the
borehole's own capacity.

A pack drafted before `evidence-10` lists neither check in its frozen report,
and its stored manifest still hashes to its recorded hash (nothing rebuilds
it). Issuing it checks the live report as well, which has both, so a draft
made on an uncapped pump can't be issued after this change (`409`, naming
the two checks; `packs.db.test.ts` pins it); an issued pack stays as it
was, and its verify and re-render read its frozen document.

## The other applications together

Report format `evidence-11` (finding C26, WP-3.11, issue #287) makes page 1's
row over the other applications, now *This and the other applications on
this baseline, together*, read **one combined run** instead of adding up
the other applications' separate runs: this application with every other
one the reader can see that is submitted, or decided with approval, and
based on this baseline (`cumulative.combined`; engine
`evidence/report.ts` `combinedOf`, backend `evidence/report.ts`
`loadCombined`).

- **Where the run comes from.** A completed cumulative assessment of exactly
  these applications with their current ops on this baseline
  ([scenarios.md § Cumulative impact](./scenarios.md#cumulative-impact-wp-311)):
  the `assessment` job already ran the baseline, each alone and all together
  on one engine, and stored the table. The report reads its outlet rows (days
  below the pragmatic EWR, Reserve months met): the combined change, the sum
  of each alone and the **interaction** (combined − Σ each alone). It does
  not run the model itself: a combination is up to 8 + 2 runs, which a
  report request (a viewer's GET, a pack draft, the issue route's live
  check) must not carry. The note names the assessment, its date and engine.
- **Only one on the baseline run's engine** (operator decision,
  2026-10-01). The assessment's baseline column is its own run of the
  baseline, so the row reads only an assessment made on the engine the
  baseline run used: its baseline figure is then the report's own. One of
  exactly these applications made on another engine isn't read; the row is
  *Not assessed* and says why (*they were assessed together on engine X, but
  the baseline ran on engine Y, …: assess them together again*). An
  assessment runs on the server's current engine, so while that isn't the
  baseline's, no new one can match either, and the row says to run the
  baseline again on the current engine and assess on that run
  (`staleAssessment`).
- **A conflict is never merged.** Without a matching assessment the backend
  still checks the combination (`checkCombination`, pure, no model run), so
  two applications that change the same thing make the row *Not assessed*
  with each conflict named (and an op that applies alone but not together
  likewise), whether or not anyone has asked for an assessment.
- **Otherwise it says why there is no figure:** no other application
  (*None*), one under way (*Not assessed yet*), none of exactly these
  (*an editor runs Applications › Assess together*), more than an assessment
  takes (8), or this application still a draft. Assessments are an editor's
  (RLS), so a viewer's report finds none (and a viewer sees no submitted
  application at all, so their row has no others to put together).
- **Confirmed (operator, 2026-10-01).** Assessments, and so the combined
  figure, stay editor-only; and a **team scenario counts as an
  application** once it is submitted, as § 4 always counted it: the s27
  question is the cumulative effect of every proposed use on the baseline,
  whoever proposed it.

§ 4 still lists each other application with its own run's change, without
the old sum, and prints the combined table (each alone, the sum, all
together, the interaction) under it. A pack drafted before `evidence-11`
keeps its frozen sum row and § 4 (no `combined`); its stored manifest still
hashes to its recorded hash, since nothing rebuilds it (`packs.db.test.ts`
pins it). The reproduction bundle doesn't carry the assessment's runs yet,
so `reproduce:pack` re-runs the baseline and the application but not the
combined row ([followups.md § Cumulative impact](./followups.md#cumulative-impact-wp-311)).

## The locality map

A licence application normally carries a site locality map, so § 1 of the
report opens with one (report format `evidence-12`, issue #326 A5). It is a
figure, not a map viewer: one SVG the engine writes from the project's map
features ([maps.md](./maps.md)), with no basemap, tiles, fonts or network,
so the browser, the server's PDF renderer and `pnpm reproduce:pack` all have
the same bytes.

**What it draws** (engine `packages/engine/src/evidence/locality.ts`, read by
`loadMapFeatures` in `backend/src/evidence/report.ts` as the reader, under
RLS, when the report is built):

| Layer | From | Named? |
| --- | --- | --- |
| Catchment boundary | the `catchment_boundary` feature | no |
| The applicant's unit (parcel) and dam | `farm_parcel` and `dam` features linked to the application's owned nodes | the unit, by its name in the run's model (the dam only when the unit has no parcel) |
| Other units' parcels and dams | every other `farm_parcel` and `dam` | **never**: no name and no node in the report, drawn alike in grey and blue; for baseline evidence every unit's are these ("Units' parcels") |
| River | `river` features | no |
| Gauge | `gauge` features | by its node's name, else the feature's |
| EWR site | a `gauge` whose node is one of the report's Reserve sites (§ 1) | as a gauge |

`other` features aren't drawn (they could be anything). Each geometry is
kept at 6 decimals of a degree (about 0.1 m) and simplified (Douglas–Peucker)
to a third of a pixel of the figure, so a 50 000-vertex river doesn't swell
the manifest; the report holds exactly what is drawn. Beside the features:
the newest change to any of them (*Features as of*), the imported files they
came from (name, SHA-256, date) and how many were drawn in the app, both
counting only what may be named: the boundary, rivers, gauges and the
applicant's own parcels and dams. Another unit's parcel or dam is drawn but
its import file is never listed, since a file is often named after the farm
or its owner (baseline evidence names no unit, so it lists no parcel's or
dam's file).

**How it is drawn** (`packages/engine/src/geo/localityMap.ts`,
`localityMapSvg`, drawing rules `locality-1`): a local equirectangular
projection about the features' centre, scaled by the WGS84 ellipsoid's
meridional and prime-vertical radii there, north up, true to scale at that
latitude (the east–west scale drifts by cos(lat)/cos(lat₀), under 1 % within
half a degree); a scale bar of the longest 1, 2 or 5 × 10ⁿ m that fits a
quarter of the map; a north arrow; coordinate ticks at a round step of
degrees; the legend; and three notes: *Base: the project's map features; no
basemap*, the features' date and sources, and the projection. Every
coordinate is written with one decimal, colours are fixed (printed on white,
whatever the app's theme) and every layer also differs by line, shape or
label. Labels are escaped. Any change to what it writes for the same data
bumps `LOCALITY_MAP_VERSION`; `localityMap.test.ts` pins a fixture's bytes by
their SHA-256 so a change can't slip by.

**Its hash.** The backend draws the SVG when it builds the report and sets
`localityMap.svgSha256` (`withLocalitySvgHash`, node:crypto). So a pack's
manifest names the exact bytes printed, and `reproduce:pack` draws the
figure again from the manifest and compares (`figure:locality`,
[§ Reproduction](#reproduction)). The page shows it as an image from a
`data:` URL of those bytes (`frontend/src/lib/components/report/evidence/LocalityMap.svelte`),
never parsed into the page as markup, with the hash under it, and its legend,
labels and notes as text for a screen reader. The server's PDF prints the
same image.

**Who sees it.** The report's readers (viewers and up) and the pack's: the
assessors' copy, like the rest of § 1. An applicant's copy of their pack and
a pack's share link show neither the figure nor its features: both are
allowlists that list neither ([§ Applicants](#applicants),
[§ Sharing and comments](#sharing-and-comments)). A farmer's map rule (only
their own farm, decision D-A1/A3 of issue #326) is a farmer's; farmers read
no report or pack.

**Without features** § 1 says *No locality map: the project has no map
features* (`localityMap: null`), and the report and pack are otherwise as
before. A pack drafted before `evidence-12` has no `localityMap`; its § 1
says the locality map isn't part of the pack, and its bundle has no
`figure:locality` check.

Tests: `packages/engine/src/geo/localityMap.test.ts` (projection against the
textbook series, the scale bar and ticks, determinism and the pinned bytes,
escaping, neighbours never labelled), `evidence/locality.test.ts` (layers,
labels, rounding and simplification, sources, the stamped hash),
`evidence/report.test.ts`, `evidence/bundle.test.ts` and
`scripts/reproduce-pack/reproduce-pack.test.ts` (`figure:locality` passes,
fails on a wrong hash or other drawing rules, is absent for an older pack),
`backend/src/evidence/report.db.test.ts` and `packs.db.test.ts` (the
features in the manifest with the SVG's hash, a moved parcel changes the
live report and not the pack, an `evidence-10` pack still verifies, an
issued pack's bundle reproduces the figure),
`frontend/…/report/evidence/locality.test.ts`, and e2e
`evidence-report.spec.ts`, `evidence-pack.spec.ts` (the figure's bytes hash
to the manifest's `svgSha256`) and `evidence-pack-pdf.spec.ts` (the server
PDF of a pack with a map).

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
| the whole evidence report: every setting, the model, every input series' hash, the results, the flags and checks, the methodology and errata cited, and § 1's locality map (its features and its SVG's SHA-256, `evidence-12`) | the sign-offs (each binds the hash in its own statement, below) |
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
  ensemble and, for an application, the paired band exist, no baseline
  assumption changed, and the two river checks pass,
  [§ What stops issue on the river](#what-stops-issue-on-the-river)). A draft cites both runs, so they are kept.
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
  rows ([security.md § Run stamps](./security.md)); no erratum found since
  the draft was made applies to either run's engine or its fit's (the pack's
  `errataFoundSince` is empty; otherwise `409` `pack_errata_since_draft`,
  naming them: the manifest would never list them, so the pack is drafted
  again, which records them, and that draft is signed and issued); and the
  live report may still be issued (the nomination, the declared rule and the
  cited ensemble haven't moved since the draft, and a draft made before
  `evidence-10` meets the two river checks its frozen report doesn't list). Then it stamps the issue (`issued_at`,
  `issued_by`, set by the database, never the caller) and, for a new
  version, marks the predecessor superseded, naming the successor.
  In the same transaction it builds the pack's reproduction bundle, checks
  it, stores it and records its hash ([§ Reproduction](#reproduction)); if
  that fails, nothing is issued. Re-running both runs to prove they
  reproduce takes as long as the runs, so it isn't done in the request: the
  issue queues a `pack_reproduce` job that does it on the server from the
  stored bundle ([§ Reproduction](#reproduction), "Re-run on the server"),
  and the bundle lets anyone do it again (`pnpm reproduce:pack`).
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
  withdrawn) pack is never deleted by the app, and a project that has one
  can't be deleted either, so its verify link keeps answering until the
  licence record closes ([§ Retention](#retention)).

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

## Retention

Provisional position (pre-counsel research, 2026-10-01; not legal advice,
and no counsel has approved it). An issued pack and a sign-off keep the names
of the people who made and signed them after their accounts are deleted:
the sign-off is the professional's own statement, and the manifest prints
its makers under the hash the verify page checks (POPIA s14(1)(b), s14(6)(b);
[security.md § Personal information](./security.md#personal-information-popia)).
"The life of the licence record" is a date the project holds
(161_licence_record, the Project page's **Licence record** panel, [api.md §
Licence record](./api.md#licence-record)):

- **Granted**: the licence's expiry date (NWA s28(1)(e), at most 40 years)
  **+ 3 years**, for a professional-negligence claim on the assessment
  (Prescription Act s11(d), s12(3)).
- **Refused or withdrawn**: the decision date **+ 3 years** (PAJA's 180
  days, Water Tribunal appeals and prescription).
- **No outcome recorded**: a review every **5 years**, from the first pack
  issued or run nominated (mirroring the NWA s28(1)(f) review interval).
  The owners record the outcome, or confirm the record is still needed,
  which sets the next review five years on.

Owners record the outcome, with a reason (the decision letter); editors
read it. Each change is in the history (`licence.outcome`,
`licence.confirmed`). The worker's tick (`backend/src/licence/record.ts`)
emails the owners and the operator (`OPERATOR_EMAIL`) when a review is due,
on the due date and then a month apart, three times in all, and once when
the closing date passes ("This licence record can now be deleted"). It
**never deletes** a licence record: the operator deletes the project, its
packs and their objects on the client's written confirmation
([deployment.md § Runbooks](./deployment.md#runbooks), "A licence record
past its closing date"). A signer is told this before signing
(`PACK_SIGNER_PUBLIC`).

A team the operator marks as keeping **public records** (`team.public_records`,
a government body such as DWS or a CMA, National Archives and Records
Service of South Africa Act s13(2)(a)) keeps its members' names in its
projects' history after an account is deleted, and its projects and the
team are deleted only after the client confirms its disposal
(`team.records_disposal_confirmed_on`; operator agreement 3A.2). Off for
every team; the operator sets it by SQL, never the app.

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
found since the draft was made, and issue refuses it
(`pack_errata_since_draft`, [§ Lifecycle](#lifecycle)) until the pack is
drafted again, which records them. So a pack is only ever issued with every
erratum known at its issue; `errataFoundSince` on verify lists only those
found after it.

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
| `figure:locality` | § 1's locality map drawn again from the manifest's features (this checkout's `localityMapSvg`) hashes to the `svgSha256` the manifest names; only for a pack with a locality map (`evidence-12`); drawn with other drawing rules, it names the engine to check out |
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

**Re-run on the server** (154_pack_reproduce, 2026-10-01). Issue checks the
bundle as `--no-run` would; the re-run takes as long as the runs, so the
issue's transaction queues a `pack_reproduce` job instead
(`backend/src/jobs/handlers/pack-reproduce.ts`, as the issuer, one pending
per pack, 3 attempts). The worker runs it as that editor, under RLS:

1. It reads the bundle back from the packs bucket under the pack's
   `bundle_key` (`getPackBundle`, checksum mode on) and hashes it against the
   pack's `bundle_sha256`, as an assessor checks the download against
   verify's `bundleSha256`. That is the `stored` check.
2. It runs the engine's `checkPackBundle` with the re-run and the pack's
   manifest hash as `--expect`: what `pnpm reproduce:pack --expect <hash>`
   prints, check for check.
3. It records the outcome through `app_record_pack_reproduction` in the
   job's transaction: `reproduced` (every check passed), `not_reproduced`
   (any check failed: the stored bytes, a file, the manifest, the inputs,
   the stored results or a re-run), `other_engine` (only the re-runs
   differ, and a run was made with another engine version than the one the
   server runs: expected, not a fault; check out that engine to reproduce
   it), or `no_bundle` (a pack issued without one). With it go the engine
   that re-ran the runs, the runs' own engines, the bundle's hash and every
   check (`pack_reproduction`,
   [data-model.md](./data-model.md#evidence-packs-112_evidence_packsql)). Once per engine version:
   the first outcome for an engine stands.

A bundle that doesn't reproduce is an outcome, recorded, and the job is
done; only what another attempt can fix (the store unreachable) fails the
job, which retries and then gives up. The pack's page says what it found, in
its bar (never printed): reproduced, with the engine and date; not
reproduced, with each failed check; another engine; still re-running; or
that the re-run couldn't be done, with why (`reproduction` on
`GET …/packs/:packId`, [api.md § Evidence packs](./api.md#evidence-packs)).
It is **not on verify**: it is the app's own claim about its own stored
bytes, not something the pack's hash covers, and an assessor repeats it
with the bundle rather than trusting it. Tests:
`jobs/handlers/pack-reproduce.test.ts` (each outcome, against a real bundle
of the engine's synthetic pack), `evidence/packs.db.test.ts` (queued at
issue, recorded as reproduced; a stored bundle replaced by other bytes
recorded as not reproduced; the writer's refusals), and the pack PDF e2e
(`e2e/tests/evidence-pack-pdf.spec.ts`, the page showing it).

**Re-run again** (operator decision, 2026-10-01). An editor asks for the
re-run again from the pack's bar (`POST …/packs/:packId/reproduce`,
[api.md § Evidence packs](./api.md#evidence-packs)) when the last one gave
up (**Try again**), when the recorded outcome is an older engine's than the
server's (**Re-run on engine X**, after an engine upgrade), or for a pack
issued before re-runs. It queues the same `pack_reproduce` job, as the
caller; while one is pending the request is idempotent (the pending job
comes back). On a newer engine the new outcome is recorded **beside** the
older engine's, never in place of it (one per pack and engine), and the
newest shows. Once the server's engine has an outcome it stands, and the
request is refused (`409`). Tests: `evidence/packs.db.test.ts` (refused on
its own engine, queued once on a newer one, recorded beside the old; a
re-run that gave up asked for again), `packs/pack.test.ts`
(`reproductionNote`'s button) and the pack PDF e2e (the button after an
engine upgrade).

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
| the standing, version, issue date, code, hashes, methodology, errata, the errata found since issue (132), signers | exactly what `GET /verify/:code` answers |
| the river's rows and EWR sites, the paired change by month, the volume rows at 5 or more farm holders | exactly what a pack link shows ([§ Sharing and comments](#sharing-and-comments)), for every standing (the applicant is the pack's party, not the public) |
| their own units: supply and reliability, baseline beside application, with the change and its band | § 4's users, for the application's owned nodes its owner still links and the nodes its proposals add |
| the other farms and water users downstream of the application: "Farm 3", "Water user 1", its change in share of demand supplied in whole percentage points | § 4's users (135_pack_security), only those the applicant's results view lists (downstream of their own and added nodes in the application run's stored model, `downstreamOf`), under the anonymous names `/base` and the results view give them (`projectBaseForApplicant`), so the pack adds no unit, and no link between a name and a place, the applicant doesn't already have. The manifest holds no network, so the set comes from the run's stored model and the names from the application's own units now, as the results view; when the run's base is no longer a published run, none are shown and the view says why. Upstream and side-branch units never appear |

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
revokes the links they made, whatever its standing, while they are still
its party; the editors still list and revoke every link. Someone who made a
link as an editor and was demoted since, and isn't a party, no longer sees
or revokes it. The link shows the public projection above
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
from the Application panel, sees their farm by name and not the neighbour
beside it, which isn't downstream, as in their results view, makes a link,
and it opens signed out); `evidence/applicant-pack-units.db.test.ts` (the other units are the
results view's downstream units under the same names; no upstream or side
unit).

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
application's pack, the scenario's owner while they still hold any role above
farmer (an applicant is a contributor; one since ranked viewer still gets it,
as the application's party who still reads its packs). Otherwise never a
viewer, a farmer, another applicant or a non-member, and never the person
who issued or withdrew it:
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
verify shows anyone already. Never a figure. It also links the recipient's
own view of the pack (**Open the pack in the catchment**): an editor's is
the pack's page, the applicant's their own copy
(`/projects/:id/scenarios/:sid/packs/:packId`, [§ Applicants](#applicants)),
never the editors' page, which they can't open. The words are in the
mail catalogue (`mail.pack.*`, `backend/src/mail/i18n/en.ts`) and follow the
recipient's language, English where a key has no translation.

There is no opt-out: like a report-ready email, it goes to the few people
who act on packs, once per issue or withdrawal. And a rare **duplicate** is
accepted: if SES accepts an email but the call times out, the retry can
send a second copy, as the alert emails can. Both decided by the operator
(2026-10-01): these are service messages to the people accountable for the
pack, and a second copy costs less than a lost one. The rows are the person's
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
