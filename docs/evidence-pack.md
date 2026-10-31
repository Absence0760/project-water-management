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
report format `evidence-12`, 2026-10-01); and whom the report is for and
whether the responsible authority endorsed its baseline
([§ The responsible authority](#the-responsible-authority), report format
`evidence-13`, 163_licensing_authority, 2026-10-01); page 1's licence
impact against full authorised use as well as modelled use
([§ Both impact bases](#both-impact-bases), report format `evidence-14`,
2026-10-01); and § 5 naming only the
applicant's own units, every other unit's registered volume and use as
totals at 5 or more units (report format `evidence-15`, decision D3,
2026-10-01; [allocations.md § In the evidence report](./allocations.md#in-the-evidence-report)); and
§ 5 saying how each unit's surface use was measured: a dam beside the river's
"taken at the intake; drawn from the dam N, not added", a dam on the river's
"dam losses N, not counted" (report format `evidence-16`, issue #516 and #507
item 7, 2026-10-10; the new fields change the manifest hash, so a pack
issued before keeps its `evidence-15` document, which the report page still
reads, without the words); and § 5 listing units one by one only for an
applicant's application, a team scenario's all in the totals, and page 1's
authorised volume mix giving no fewer than 5 registered users' volume
(report format `evidence-17`, issue #523 G1, 2026-10-11); and § 5's
*Other registered users* totals gated on registered users, not units, and
per water year on the holders whose volumes are in force that year, none
dominating (a year too few hold, or one or two hold most of, reads "not
shown", its modelled use kept; holders counted by keys frozen with each
run), with the folded
mix frozen as whole-percent shares with no m³ (report format
`evidence-18`, issue #523 G/H/J, 2026-10-11); page 1's headline against
full authorised use recording how to re-derive its pair (report format
`evidence-19`, issue #523 G2); and § 4 naming every other application
that counts but has no run of the ops it counts with, and saying which
terms each listed run applied (report format `evidence-20`, issue #523
G3/G4, 2026-10-12; [§ The responsible authority](#the-responsible-authority)); and § 7's
observed wet days of the applicant's own dams from Digital Earth Africa's
WOfS (report format `evidence-21`, issue #604 R5-C, 2026-10-27;
[§ Observed wet days](#observed-wet-days)); and § 3's calibration zones,
every zone's parameters, fit record and statistics, and the regional GR4J
prior when the baseline's parameters came from it (report format
`evidence-22`, issue #555 and #622, 2026-10-28; [§ Calibration
zones](#calibration-zones), [§ The regional prior in
§ 3](#the-regional-prior-in--3)); and § 8's future yield of an application
under each climate model's monthly change factors (report format
`evidence-23`, issue #621 slice 4, 2026-10-29, 280_future_yield;
[§ Future yield](#future-yield)); and § 7 counting Sentinel-2 beside WOfS,
each source and the dates either saw together (report format
`evidence-24`, issue #624 step 7, 2026-10-29; [§ Observed wet
days](#observed-wet-days)); and § 3's calibration locations, each with its
period and every land unit with where its parameters come from (report
format `evidence-25`, issue #659, 2026-10-30; [§ Calibration
zones](#calibration-zones)); and § 4's dams the applications touch, each
dam's firm yield and assurance of supply together (report format
`evidence-26`, 2026-10-30; [§ The other applications
together](#the-other-applications-together)), and its background at full
allocation as its own rows, when it has one (also `evidence-26`, WP-3.10,
295_assessment_background); and page 1 and Appendix A.2 printing the
water-use licence application the scenario models and which of its works
each change models (also `evidence-26`, 294_wula_reference, 2026-10-30;
[§ The WULA reference](#the-wula-reference)). What is left is
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

§ 7's observed wet days (report format `evidence-21`, issue #604 R5-C) are
`report.damObservations`: each of the applicant's own traced dams with
every WOfS date in the baseline's period (wet area and share seen) and the
wet, dry and inconclusive counts, read when the draft is made, so the
manifest freezes them and its hash covers them, and `reproduce:pack`
classifies them again ([§ Observed wet days](#observed-wet-days)). No manifest
version changed, as for `evidence-8`. A pack drafted before has no
`damObservations`: its stored manifest still hashes to its recorded hash,
and its report prints without § 7. From `evidence-24` (issue #624 step 7)
§ 7 counts Sentinel-2 beside WOfS (counting `dam-obs-2`); a pack drafted
from `evidence-21` to `evidence-23` keeps its WOfS-only `dam-obs-1` section,
hash and table, and `reproduce:pack` still checks it as it was.

### The regional prior in § 3

§ 3 (*Model and data*) names the regional GR4J prior (report format
`evidence-22`, issue #622, [model.md §2.10m](./model.md)) as
`report.credibility.regionalPrior`, built from the baseline run's input
snapshot only (`evidence/regionalPrior.ts`), so it says what that run ran
on:

- when its fit record used the prior (a penalty, its p10–p90 box or both)
  and its fitted parameters weren't edited since: "Parameters calibrated
  with the regional prior, n donors; penalty weight w, search held to its
  p10–p90 box.";
- else, when the parameters are still the medians a "Start from the prior"
  wrote for the target they are now (the catchment, or under calibration
  zones the site's own zone and its units) and no fit was applied after it:
  "Parameters from the regional prior, n donors (the donors' medians, not
  calibrated).";
- else nothing (`null`).

Either line goes on with the donor set's label (and "invented donors" for
the synthetic set), how many were offered, the first 12 hex digits of its
SHA-256 and the leave-one-out skill, ending "the prior has no skill" at 0
or below, or saying its skill is unknown when there were too few donors to
score it. The report shows the line above *Validation*. The manifest's
hash covers it; no manifest version changed, as for `evidence-8`. A pack
drafted before has no `regionalPrior`: its stored manifest still hashes to
its recorded hash, and its § 3 prints without the line.

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
  - a demand's own river abstraction beside a unit's dam (engine ≥ 1.65.0,
    model.md §2.7j): the crops' (with a crop area) or an enabled demand
    object's, with no pump capacity; 0 means no pump. It keeps the unit's
    hands-off flow, so `protectsEwr` reads the unit's;
  - a river off-take whose rate isn't a number and has no daily cap. Its
    capacity is the month's rate × 86 400, capped by the daily cap (§2.6a),
    so a stored off-take normally passes.

  River to dam always has its capacity. A unit whose abstraction starts after
  the run ends (§2.7g) takes nothing in it. Without a cap, only the river's
  flow limits the take, which is no basis for licensing a volume. The fix
  names what to enter for each kind (a pump capacity under Network › the
  unit › Supply, a river abstraction's pump under Water for the crops or
  the demand object, run of river for a dam-less unit, the user's pump capacity,
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
- **Against existing authorised use, beside the baseline** (report format
  `evidence-26`, WP-3.10). When the assessment the row reads was also run on
  a background at full allocation (an assessor's choice, 295,
  [scenarios.md § Against existing authorised
  use](./scenarios.md#against-existing-authorised-use-a-background-at-full-allocation)),
  § 4's combined table is followed by that background's own rows
  (`cumulative.combined.background`: its label *Existing authorised use (full
  allocation)*, the run's label, and at the outlet its days below the
  pragmatic EWR and Reserve months met, against the baseline's, with the sum
  of each application alone, all together and the interaction on it). The
  baseline's figures and page 1's row are unchanged: licences never drive
  the baseline (issue #507), so the background is never read in its place.
  Days and months only, the verdicts and counts D3 gives every reader of a
  full-allocation run, so a reader kept from the volumes reads them as they
  are; a viewer finds no assessment, so no background either. A pack drafted
  before `evidence-26` keeps its document without them; one drafted after
  from an assessment without a background has `background: null`.

§ 4 still lists each other application with its own run's change, without
the old sum, and prints the combined table (each alone, the sum, all
together, the interaction) under it. A pack drafted before `evidence-11`
keeps its frozen sum row and § 4 (no `combined`); its stored manifest still
hashes to its recorded hash, since nothing rebuilds it (`packs.db.test.ts`
pins it). The reproduction bundle doesn't carry the assessment's runs yet,
so `reproduce:pack` re-runs the baseline and the application but not the
combined row ([followups.md § Cumulative impact](./followups.md#cumulative-impact-wp-311)).

**Yield and reliability per dam** (report format `evidence-26`, 2026-10-30).
Under the combined table, *All of them together* lists each dam the
applications touch (`cumulative.combined.dams`, engine `combinedDams`,
`evidence-combined-dams`): its firm yield (m³/year) on the baseline, the
change with every application together and the interaction, and its unit's
annual assurance of supply on the baseline and the change, read from the same
assessment's dam rows ([scenarios.md § Cumulative
impact](./scenarios.md#cumulative-impact-wp-311): at most
`floor(160 ÷ (applications + 2))` dams (each firm yield its own job, 297); the rest are in the assessment's
warnings, which § 4 prints). Each dam also carries the **direction** of
each measure together against the baseline (`verdict`: `lower`,
`unchanged` within the yield search's 0.1 % tolerance, or `higher`).
**Privacy (D3, #523 I):** a firm yield on a run that caps use at, or
scales demand to, the registered volumes rests on them, as the Yield
panel's points do. So a reader kept from the volumes reads a dam whose
assessment had such a run (`onVolumes`) as its direction only, figures
`null` and `withheld: true` (`combinedDamVerdicts`: in
`redactReportAllocations`, the live report and an issued pack alike), and
on a report on such a run every dam so (`verdictsReport`); a dam whose
runs never touched the volumes is read in full. An assessment made before
the dam rows gives an empty list, and a pack drafted before `evidence-26`
keeps its document, without them.

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

## Observed wet days

An application to build or raise a dam, or to take more from one, is
stronger with what the dam has actually held. § 7 of an applicant's report
(report format `evidence-21`, issue #604 R5-C; Sentinel-2 from
`evidence-24`, issue #624 step 7) gives, for each of the applicant's own
traced dams, on how many dates a satellite saw it wet, on how many dry, and
on how many it couldn't say, over the baseline run's period. It is evidence
beside the model, never an input to it.

**Where the numbers come from.** Two optical sources, each summed inside the
dam's own outline on the Map by the fetcher and loaded into
`dam_observation` ([architecture.md § Dam
observations](./architecture.md#dam-observations),
[data-sources.md](./data-sources.md)), one row per dam, source and date: the
wet area seen and the share of the outline seen clearly (`pct_observed`).

- **Sentinel-2** (source `s2`, migration 278; [data-sources.md
  § deafrica-sentinel-2-c1](./data-sources.md#deafrica-sentinel-2-c1)):
  Copernicus Sentinel-2 L2A Collection 1 as Digital Earth Africa publishes
  it, classified by us (MNDWI > 0 from B03 and B11, NDWI where B11 is
  missing, the SCL band masking cloud and shadow; model.md §2.10l). 10 m
  pixels, a dam seen every few days, history from 2019 (the pass's
  backfill). A 0.3 ha farm dam is about 30 of its pixels, where Landsat's
  30 m grid gives it three or none.
- **WOfS** (source `wofs`, migration 261): Digital Earth Africa's Water
  Observations from Space (CC BY 4.0), one Landsat scene at a time, 30 m,
  a dam seen every 8 to 16 days, history from 2013.

Not counted: **Sentinel-1 radar** (`s1`) sees through cloud, but wind
roughens open water and wet sand reads as water, so it is never alone the
reason a dam is called full or empty (model.md §2.10l), and a wet or dry
date is exactly such a call. **Waterbodies** (`waterbodies`) is DE Africa's
own polygon, not the dam's traced outline. Neither is read for § 7 (`loadDamObservations`).

**What is counted** (engine `packages/engine/src/evidence/damObservations.ts`,
`damObservationsSection`, counting `dam-obs-2`, read by
`loadDamObservations` in `backend/src/evidence/damObservations.ts` as the
reader, under RLS, when the report is built). Each observed date of a
source is read by that source's rule (`classifyDamDate`,
`DAM_OBSERVATION_RULES`), **provisional** (the lead's method decisions of
2026-10-27 for WOfS and 2026-10-29 for Sentinel-2; open to the client
hydrologist's review):

| Column | WOfS | Sentinel-2 |
| --- | --- | --- |
| Dates observed | dates in the period with a WOfS row for the dam | dates with a Sentinel-2 row |
| Wet | at least 2 wet pixels of 900 m² (about 1,800 m²), at **any** clear share | at least 8 wet pixels of 100 m² (about 800 m²), at **any** clear share |
| Dry | no wet pixel, with at least 99 % of the outline seen clearly | the same |
| Inconclusive | anything else | anything else |

And for each dam, **Either satellite**: every date either source saw,
counted once (`combinedDamDates`). A date is read by the first source, best
first, whose call is wet or dry: Sentinel-2 (the sharper outline), then
WOfS, the order of the *Seen from space* panel's source precedence
(`dams/observed/compare.ts` `SOURCE_PRECEDENCE`). A date neither can call is
inconclusive.

Why this rule:

- **Wet needs no full view.** Water seen is water there, so a date counts as
  wet whatever share of the outline cloud or shadow hid. A minimum of two
  pixels, not one, screens out single-pixel noise at the edge of a dam: a
  mixed shoreline pixel, terrain or cloud shadow the masks missed, wet soil.
- **Sentinel-2's two pixels are 20 m ones.** Its water test reads B11 at
  20 m, and its cloud mask (SCL) is 20 m too: each 20 m cell is assigned to
  the four 10 m pixels whose centres fall in it, so one noisy 20 m cell is
  up to four wet 10 m pixels. Eight 10 m pixels are at least two 20 m cells,
  the same two-pixel screen as WOfS's at the resolution the water test is
  really made at (the *Seen from space* panel's seen-empty floor is one
  20 m cell, 400 m², for the same reason).
- **Dry needs nearly the whole view.** A dry claim says there was no water
  anywhere in the outline, and the last water in a drawn-down dam is a pool
  at the wall, often a few pixels. A 90 %-clear view (the share DE Africa
  Waterbodies takes as a valid observation) can miss exactly that, and the
  low-storage case is the one a licence assessor cares about. So dry asks
  for 99 % seen and not one wet pixel, from either source.
- **The sharper source decides a shared date.** Both pass at about 10:00
  local time, so a date both saw is one state of the dam. Sentinel-2's
  10 m view of a small dam is the better one; but a clouded Sentinel-2 view
  doesn't throw away a clear Landsat call the same day.
- **Inconclusive is counted, not dropped**, so the reader sees how many
  dates the rule couldn't call, and the wet and dry counts never look like
  more of the record than they are.

The pixel count comes from the stored wet area: `dam_observation` holds
the wet area (wet pixels × the pixel's ground area), not the count, so the
count is the wet area over the source's nominal pixel area (900 m² for
WOfS's 30 m, 100 m² for Sentinel-2's 10 m), rounded. The UTM scale moves a
pixel's ground area by under 0.2 % across a zone, so the rounding gives
back the pass's own count. Every observed date of each source is frozen in
the report (`dams[].sources.<source>.dates`: each date, its wet area in m²
and the share seen), with each source's rule (`sources[]`:
`wetMinPixels`, `dryMinClearPct`, `pixelAreaM2`) and credit, so the counts
can be checked, and an assessor can look up the scene for a date (the
dam's outline and the date are enough in DE Africa's STAC search;
`dam_observation.upstream_key` holds the item id the app used). One row a
dam, source and date (the table's unique key): the section refuses a date
given twice for one source rather than keep either.

**The table.** Per dam, three rows: *Either satellite* (the dates
together, the dam's headline), then *Sentinel-2 (10 m)* and *WOfS (Landsat,
30 m)*, each with its dates observed, wet, dry and inconclusive, and the
span of its dates. A dam traced but never seen shows zeros.

**Whose dams.** Only the applicant's own units' dams in an applicant's
application, by the same rule as § 5 (decision D3): a team scenario's units
are an editor's choice, and baseline evidence names no one's farm, so
neither has § 7 (`damObservations: null`). An applicant with no dam traced
on their units gets § 7 with *No dam on the applicant's units is traced on
the map*. A neighbour's dam is never listed. The section is in the
assessors' copy and the PDF; like the locality map it isn't on the
allowlists of an applicant's copy or a share link
([§ Applicants](#applicants), [§ Sharing and comments](#sharing-and-comments)).
It rests on nothing registered, so a viewer kept from each registered
volume reads it whole (`backend/src/allocations/verdictsOnly.ts`).

**Attribution.** § 7 prints *Source: Digital Earth Africa WOfS, CC BY 4.0,
summed inside the dams' traced outlines by this app* (`WOFS_CITATION`), and
with any Sentinel-2 date in the table *Sources: Digital Earth Africa WOfS,
CC BY 4.0, and Sentinel-2, each summed inside the dams' traced outlines by
this app. Contains modified Copernicus Sentinel data [year], processed by
Digital Earth Africa.* (`SENTINEL_CITATION`; [year] the first and last year
of the Sentinel-2 dates counted, `sentinelCitation`, in
`evidence/sentinelCredit.ts`, the one definition the panel's
`sentinelCredit` reads too), the credit the EU's legal notice asks for
([data-sources.md § deafrica-sentinel-2-c1](./data-sources.md#deafrica-sentinel-2-c1)).
The credit is frozen in `sources[]` and checked against the dates.

**Reproduction.** The observations aren't re-fetched: what is checked is
that the counts follow from the frozen dates (`checkDamObservationsBySource`),
one check a source and one for the dates together:

- `observations:s2` and `observations:wofs`: that source's dates
  classified again under its rule, the dates ISO, in order and inside the
  period, the counts whole numbers, the rule's numbers the code's, and its
  credit (Sentinel-2's naming the years of its dates);
- `observations:days`: the dates either saw counted again from both
  sources' frozen dates, best first.

A problem with the period (it must be the baseline run's as the manifest
records it, `identity.baseline`), the sources' list or the counting version
fails all three, since every count rests on it. The manifest hash covers
§ 7 whole, but a report counted over another span would hash just as well,
so the period is checked against the baseline's too. Another counting
version names the engine that built the report (`builtBy`), as
`figure:locality` does. The bundle gains no file and its layout no version
([§ Reproduction](#reproduction)).

**Older packs.** A pack drafted from `evidence-21` to `evidence-23` froze
§ 7 as `dam-obs-1`: WOfS alone, one row a dam (`dams[].dates` and its
counts on the dam), one rule (`wetMinPixels`, `dryMinClearPct`,
`pixelAreaM2` on the section) and `citation`. Nothing rebuilds it: its
hash, its table (no *Satellite* column) and its credit stay as they were,
and `reproduce:pack` checks it with the one `observations:wofs` check it
had (`checkDamObservations`, which reads either counting).

Tests: `packages/engine/src/evidence/damObservations.test.ts` (each rule at
its edges: WOfS's 2 pixels at a 12 % view, 1 pixel, exactly 99 % and just
under, the UTM scale's spread; Sentinel-2's 8 pixels at a 15 % view and 7;
the dates together, a clouded Sentinel-2 view leaving a date to WOfS and a
clear one taking it; the credit's years; the period; only the applicant's
dams; a repeated date per source; each check's refusals on its own check;
and the `dam-obs-1` builder and check as before), `evidence/report.test.ts`
(`evidence-24`, null for baseline evidence and a team scenario),
`evidence/bundle.test.ts` (the three checks pass, each fails alone on its
own tampering, a wrong period fails all three, `builtBy` on another
version, an older pack's `observations:wofs` alone, absent before
`evidence-21`), `scripts/reproduce-pack/reproduce-pack.test.ts` (the same
through the CLI, both countings),
`backend/src/evidence/damObservations.db.test.ts` (the query: WOfS and
Sentinel-2, never Sentinel-1 or Waterbodies, with positive controls; RLS: a
member and the dam's farmer read them, a stranger and a neighbour's farmer
don't), `evidence/report.db.test.ts` (an applicant's report has § 7 from
the stored rows of both sources and not the radar's, a team or baseline
report none, the applicant reads the rows and a stranger neither them nor
the report), `evidence/packs.db.test.ts` (an issued applicant pack's
manifest hash covers § 7 and its stored bundle passes the three checks; an
`evidence-23` pack's `dam-obs-1` § 7 still matches its hash and checks),
`backend/src/dams/observed/observations.security.db.test.ts` (an applicant
never reads another applicant's dam rows),
`frontend/…/report/evidence/damObservations.test.ts` (the rows, both
countings, and the credit line), `frontend/…/report/evidence/sections.test.ts`
(§ 7 listed only for an applicant's application), and
`e2e/tests/evidence-report.spec.ts` (§ 7's table with both satellites and
the Copernicus credit on an applicant's report, none on a team
application's or the baseline's).

## Future yield

A dam licence lasts decades; every other number in a pack replays the
historical record. § 8 of an application's report (report format
`evidence-23`, issue #621 slice 4) reruns the pack's baseline and
application under downscaled climate change factors and shows, as a range
across climate models, the applicant dam's yield, the applicant's
assurance of supply and the change in EWR compliance.

**What a case is.** One climate model × SSP (SSP2-4.5, SSP5-8.5) × horizon
(2036–2065, 2066–2095): its 24 monthly change factors (rain as a ratio of
means, evaporation as a ratio of Hargreaves–Samani PET, against 1985–2014,
area-weighted over the catchment boundary's 0.25° cells; round 1's
`climateDeltaFactors`, [model.md §2.17](./model.md)), applied to both runs'
stored inputs as a `climate.delta` op. Per case the engine
(`packages/engine/src/evidence/future.ts`, `runFutureYield`, builder
`future-1`, method `delta-1`) runs the baseline and the application and
reads:

| Column | What |
| --- | --- |
| Firm yield | the applicant's dam's firm yield on the application (§2.13, constant draft, no failure day), m³/a |
| Yield at 98 % | its yield at 98 % assurance (failed water years at most 2 %), m³/a |
| Applicant's assurance | water years met ÷ water years over the applicant's own units on the application (`supplyAssurance.reliability`, pooled; the project's annual threshold) |
| Change in days below the EWR | the application's days below the pragmatic EWR at the outlet less the baseline's, each under the same factors |

The section prints the historical value (the same inputs, no op), then per
SSP and horizon the median across models with the smallest and largest,
never one number. **Fewer than 5 models** (`FUTURE_MIN_MODELS`) and it says
so in a banner (`fewModels`): the committed synthetic copy has 3 invented
models (SYN-A..C), so every dev, CI and e2e report shows it. The dam is the
application's only own unit with a dam above 0 m³, or the one the request
names.

**Where the numbers come from.** A `future_yield` job (280_future_yield,
`backend/src/jobs/handlers/future-yield.ts`), queued by an editor with the
draft report's **Run the future yield** button (a board above the report,
`FutureYieldRun.svelte`: editors only, never on a pack, following the job
queued, running or failed and reading the report again once it is done;
**Run it again** once § 8 has a result; **Cancel** while it waits or runs,
284_cancel_future_jobs: a running job stops after the model it is reading
from the copy or the case it is running, before the next, storing nothing;
its progress bar counts the models read, then the cases run), or through the API
(`POST …/runs/:runId/future-yield`, [api.md § Future yield](./api.md#future-yield)),
reads the copy's `cmip6/<model>/<scenario>` monthly aggregates
(`backend/src/future/copy.ts`; the committed synthetic copy in dev, CI and
e2e) over the project's `catchment_boundary` (`future/cells.ts`, the 0.25°
cells weighted by share inside × cos latitude), works the factor table out
(`buildFutureFactorTable`) and runs every pair (about 40 runs and twice as
many yield searches for 10 models) as the editor, under RLS, then stores
one `future_yield` row (the newest 3 per pair are kept). The evidence report
reads the newest row for its two runs and freezes it whole. An application
whose own ops already assume a climate (`climate.delta`) is refused. It is
**off** unless `FUTURE_YIELD=on` ([deployment.md § NEX-GDDP-CMIP6
(one-off)](./deployment.md#nex-gddp-cmip6-one-off)): off, no report has § 8
(`futureYield: null`); on with no result for the pair, § 8 prints *Not
assessed*. Baseline evidence never has § 8.

**What the manifest freezes.** `report.futureYield`: the result whole,
including the factor table (`factors`: method `delta-1`, the three windows,
each case's 24 factors and the years of each window the copy held, and per
product `cmip6/<model>/<scenario>` its manifest revision, the count and
SHA-256 of its files in the windows (canonical JSON of `{ url, valuesSha256 }`
sorted by URL), their versions and their `license` attributes verbatim), the
engine that ran the pairs, who ran it and when, and the caveat as it stood.
One digest a product rather than a row a file: ten models' windows are some
4,500 files. No manifest version changed, as for `evidence-8`; a pack drafted
before has no § 8.

**The caveat.** § 8 opens with ours (projections, not predictions; what BCSD
does and doesn't correct; delta change keeps the historical sequence, GR4J
keeps its parameters, evaporation moves by a temperature-only ratio) and
NASA's own caveat on engineering use, **quoted verbatim** from the
product's technical note with its address and the date read
(`FUTURE_YIELD_CAVEAT` in `evidence/future.ts`). The note the research
cited (`NEX-GDDP-CMIP6-Tech_Note_4.pdf`) returned 404 when this was built,
so NASA's words are **a marked placeholder** for now.

**What stops issue.** The `futureYield` check (`blocksIssue`, never
`refuses`) fails while NASA's caveat isn't quoted (`futureCaveatPending`:
text, address and date all needed) or while any factor rests on part of its
30-year window (`futureFactorsComplete`: the synthetic copy holds 2 baseline
years and 1 of each future window). Since a pack is drafted only from an
issuable report, **no pack with § 8 can be made** until both are fixed; the
section still previews on the report. Filling the caveat is a code change
(the constant, with its test), deployed.

**Sign-off.** The applicant's specialist signs § 8 by name: a pack whose
manifest has a § 8 result signs statement `pack-signoff-2`, which adds the
`futureYield` confirmation (*"I have read § 8 Future yield, its caveat and
its change factors…"*, `liability/signoff.ts`); a pack without § 8 keeps
`pack-signoff-1` word for word. The specialist reads no pack row, so
`app_specialist_pack` (280) says whether the manifest has § 8.

**Who reads it.** A viewer and above, and the applicant on their own
application (`app_future_yield_own_run`); no farmer. A viewer kept from the
registered volumes on runs that cap or scale use to them reads neither the
section (`verdictsOnly.ts` lists it nowhere) nor the result's numbers on
`GET …/future-yield`. Like § 7 it isn't on the allowlists of an applicant's
copy or a share link.

**Reproduction.** `climate:delta` ([§ Reproduction](#reproduction)): every
pair run again from the frozen factor table on the bundle's own inputs
(`checkFutureYield`), and the historical pair, every case and every range
compared with the manifest. The NEX-GDDP-CMIP6 files aren't in the bundle;
the manifest names each product's file digest. The bundle gains no file and
its layout no version.

Tests: `packages/engine/src/evidence/future.test.ts` (the ranges; each case
against its op run by hand; factors of 1 give the historical values to the
bit; the firm yield never falls as the rain factor rises; refusals; the
re-check passing and failing; the factor table from cells, whole and
partial windows; the caveat's guard), `evidence/report.test.ts` (frozen
whole, the check on a pending caveat and on partial windows, *Not assessed*,
null for baseline evidence), `evidence/bundle.test.ts` and
`scripts/reproduce-pack/reproduce-pack.test.ts` (`climate:delta` passes,
fails on a tampered case, absent before `evidence-23`),
`liability/validation.test.ts` (`pack-signoff-2`), `backend/src/future/cells.test.ts`,
`backend/src/future/future-yield.db.test.ts` (off by default; the request's
refusals; the job over the synthetic copy; RLS with a viewer as positive
control, a stranger and another contributor reading nothing; the report
freezing it and held from issue; a copy with no projections), the catalogue
guards, `frontend/…/report/evidence/future.test.ts` and `sections.test.ts`,
and `e2e/tests/evidence-pack.spec.ts` (run on the synthetic copy, the
caveat's placeholder, the few-models and partial-window banners, the table,
and no pack made of it).

## Calibration zones

A baseline calibrated at several locations (model.md §2.10n) runs each
ticked location's group of land units on that location's own GR4J
parameters, so the headline location's parameters and fit no longer
describe every unit's runoff. From report format `evidence-22` (issue #555,
`evidence/calibrationZones.ts` `calibrationZonesSection`) the document
carries `calibrationZones`: one entry per group the baseline applied, in the
run's order (upstream first, the headline location last, `headline`; then
the units on the catchment parameters, `kind` 'default'; a run from before
engine 1.110.0 has the calibration site's own zone last, `nodeId` null and
no `kind`), each with

- its location's name and `kind` (a gauge's, the outlet's), its land units'
  count and area (km², the run's model),
- from `evidence-25` (issue #659): its period (`window`, the gauge row's or
  the outlet's top-level window, null ends the record's own; none for the
  catchment-parameter units) and every unit in its group by name with where
  its parameters come from (`members`, from `summary.unitRain.paramSource`:
  `zone` its own zone, `assigned` borrowed by Parameters from, `rest` the
  rule for units outside every location, `default` the catchment
  parameters; a run from before engine 1.110.0 recorded none, so they are
  read from its network: a gauge's units and those draining through its
  calibration site are `zone`, the site zone's units beside or below the
  site `rest`). The
  pack already names every unit (§ 4); an applicant's copy is an allowlisted
  projection that holds no calibration section ([§ Applicants](#applicants)),
- the X1–X4 its units ran on (`summary.unitRain.zones`), and whether they
  were the zone's own or the catchment's (`fitted`),
- its fit (`fit`): the fit record's description, its engine version, its
  objective, its in-sample score and its split-sample and dry → wet scores
  on that objective (null when the test wasn't run), and the parameters
  edited since (judged against the parameters the units ran on, as the run's
  `fitStatus` is, not the record's stored list); null when the zone's
  parameters don't come from a stored fit,
- the run's statistics at its location (`stats`: days, NSE, KGE, PBIAS and
  `fitStatus`, the location's own in or out of sample; the headline's are the
  run's calibration statistics), null with no scored day.

§ 3's calibration record and validation read the headline location's window
and fit record (the frontend's `zones.ts` `runHeadlineSettings`, the engine's
`headlineCalibrationSettings`, issue #659: a gauge's row when the
headline is a gauge, the top level for the outlet, a legacy site's as it ran).

Everything is read from what the run froze (its summary, settings snapshot
and model), so the manifest's hash covers each zone's parameters and fit
record (they were already in `appendix.baselineInputs`; the section states
them), and reproduction re-derives them from the re-run. A zone above the
site with no stored fit raises the caution flag `zoneNoFit` ("Validation not
assessed for the calibration zone at …"), and each zone's fit engine
reaches the report's errata (an erratum keyed on the fit's engine). The
run's validation statement, its sign-off statement and its *May be
affected* status still read only the site's fit engine
(followups.md § Calibration zones). The input diff
(Appendix A.2) words each zone (run-comparison.md). Null when the baseline
ran one parameter set; absent from a pack drafted before `evidence-22`,
which keeps its document. § 3 prints the section as a table
(ui.md § Evidence report). The uncertainty ensemble still varies only the
site's parameters (followups.md § Calibration zones).

Tests: `evidence/calibrationZones.test.ts` (the fit's scores, the errata
versions, the flag, each location's period and each unit's source, the
headline's settings), `evidence/report.test.ts` (a zoned baseline's section,
upstream first, its gauge scored on its own record, and null with one
parameter set), `frontend/src/lib/calibration/zoneStats.test.ts` (the table's
rows, the headline first), the evidence DB tests.

## The WULA reference

Report format `evidence-26` (294_wula_reference;
[scenarios.md § The WULA reference](./scenarios.md#the-wula-reference)).
The report prints the water-use licence application (WULA) the scenario
models, so the assessor can tell whether the change modelled is the one
applied for:

- **Page 1** (`identity.application.wula`): the WULA's number (or *No
  application number given*), the refs of the works as applied for, and how
  the run's recorded changes meet them: how many proposals model none of the
  works, and which works no change models. Not the works in words: those are
  the applicant's, and page 1 holds none of the applicant's own words (G13).
  `null` for a team scenario that records no reference; every application
  has one, empty or not.
- **Appendix A.2** (`appendix.wulaWorks`): the number again and the works in
  words, then each change with the works it models (its `works` tag, read
  from the ops the run recorded), *Names "X", which the WULA doesn't list*,
  or, for a proposal, *Models none of the works applied for*.
- **Questions**: a missing number, proposals tied to no works and works no
  change models each add an assessor's question. None stops issue: the tie
  is the applicant's statement of what models what, not a check of the
  model.

The tie reads the **run's recorded ops** (a tag added to the scenario after
the run shows on the next run, which is why the question says to run the
application again); the number and the works are the scenario's as it holds
them now, which is the submitted reference once it is submitted
(`scenario_wula_frozen`). The report is hashed into the pack's manifest, so
a pack drafted before `evidence-26` keeps its document without either, and
its page says nothing of a WULA.

## The responsible authority

Report format `evidence-13` (163_licensing_authority; provisional position,
pre-counsel research, 2026-10-01; D1 and D14 in
[step-3-licensing.md § 11](./roadmap/step-3-licensing.md)). Under the
National Water Act only the responsible authority decides a licence and
decides what evidence it accepts (s41(2)), so the report says whom it is
for and whether that authority accepted the baseline:

- **For** (`identity.authority`, the identity block's *For* row): the
  project's `settings.responsibleAuthority` (name, DWS or a CMA, office), or
  *No responsible authority named*.
- **The baseline's endorsement** (`identity.baseline.endorsement`, under
  *Baseline*): the newest endorsement of any publication of the baseline
  run, by a member acting for the authority (`POST
  …/publication/:pubId/endorse`): when, by whom and its note. Without one,
  the identity block says *Not endorsed by the responsible authority* and
  page 1 carries a caution flag, `notEndorsed`, *Baseline not endorsed by
  the responsible authority.* (a fixed row: absence is printed, never
  omitted, G6).
- **§ 4's decided applications** carry the authority's outcome words; only
  a licence in force counts among the other applications on the baseline (a
  pack drafted before keeps its frozen `approved` /
  `approved_with_conditions`, which it still words). Since 227/228 (issue
  #523 G3, G4) it counts on its **granted terms**, never the changes applied
  for: § 4 reads its newest run of those terms (an assessor's **Run the
  licensed terms**; the run of the applied changes no longer stands for
  it), each row saying its run applied the licensed terms (`terms:
  'licensed'`, a submitted application's `applied`), and page 1's combined
  row matches an assessment that took those terms. A licence set aside on
  appeal stops counting; one varied counts on the variation's terms, read
  from a run of them; an appeal only lodged changes nothing.
  **Nothing drops out silently** (report format `evidence-20`): an issued
  licence with no run of its licensed terms on this baseline (granted on
  other terms than applied for, or varied since its run), and a submitted
  application never run on it, can't be in the table or its sum, so § 4
  names them with a fixed line (`cumulative.notRun`, `notRunCount`,
  `notRunNote`: *Not in the table or its sum: N licences in force have no
  run of their licensed terms on this baseline (…), so the table leaves
  their change out: run them from the application (a licence: Run the
  licensed terms) and build the report again.*), under the reader's RLS as
  the table is (a viewer sees no submitted application, so isn't told its
  name). The licensed-terms run isn't made automatically when the decision
  or variation is recorded: a scenario run is an engine run on the request
  path (`runScenario`), and no job kind runs a scenario, so the line is the
  guard ([followups.md § Licence terms and appeals](./followups.md#licence-terms-and-appeals-issue-523-g3-g4-2026-10-12)). A pack
  freezes which applications and runs it read, so a decision or appeal
  recorded later changes the live report, never an issued pack; one
  drafted before `evidence-20` has no such line or `terms`. The applicant reads the
  granted terms and the appeal events on their own application (§
  Applicants).

Both are part of the report, so a pack freezes them when it is drafted: an
authority named, or an endorsement made, after a pack is issued changes
the live report, never the pack or its hash (`evidence/packs.db.test.ts`).
A pack drafted before `evidence-13` has neither field; its identity block
says nothing about the authority and it has no such flag.

**Who acts for the authority is the authority's own call**
(229_authority_delegates, issue #523 G5; the assessor's review of D1). An
endorsement, a decision, a registration check and the pack's *Send to the
authority* count only a **confirmed** delegate holding editor or above in
the project (directly or through its team): an owner (the host) may
propose someone, but a proposal grants nothing until a member already
acting for the authority confirms it, or, for a project's first delegate,
the operator on the authority's written request. The owner can withdraw a
proposal but not remove a confirmed delegate; the authority removes anyone.
So *Not endorsed by the responsible authority* stays printed until someone
the authority confirmed endorses the baseline, whatever the host does.
Every change is in the project's History ([security.md § Authorization](./security.md#authorization-per-project-roles-enforced-by-postgres-rls), [data-model.md](./data-model.md) `authority_delegate`).
The flags owners set before 229 were carried over as confirmed, each with
an `authority.grandfathered` event naming who set it.

### Both impact bases

Report format `evidence-14` (licensing build item 8; provisional position,
pre-counsel research, 2026-10-01; D15 in
[step-3-licensing.md § 11](./roadmap/step-3-licensing.md)). Page 1 judges
the application twice, both labelled:

- **Against full authorised use** (the headline, `licenceImpactAuthorised`):
  the baseline and the application both run with every holder at their
  registered volume (`allocationMode: 'fullAllocation'`). NWA s27(1)(a) and
  (f) have the authority weigh existing lawful uses and the effect on other
  users, and s29(1)(a)(iii) and R267's "cumulative impact" protect existing
  *and potential* use: a proposal that passes only because other holders
  don't take their full entitlement would hurt them as soon as they do.
  Beside it, the authorised volume's mix by how it is held: a licence
  (s40) and an existing lawful use verified under s35 are entitlements; a
  WARMS registration, a claimed existing lawful use, a general authorisation
  and Schedule 1 use are not, and the table says which. Since
  `evidence-17` the pack freezes the mix twice: in full (editors, owners,
  the authority and the PDF read it) and folded, which a viewer kept from
  each registered volume reads in its place: no line is fewer than 5
  registered users' volume. Since `evidence-18` the folded one is frozen as
  each line's whole-percent share, with no m³ and no total (`mixShares`;
  an `evidence-17` pack's or board's folded m³ is served to that viewer as
  its shares). The mix sums every row of the baseline, whatever its dates,
  while that viewer's live totals are of the rows in force today, so an m³
  total beside them gave the rows out of force by subtraction (#523 H), and
  a kind's line beside the per-source totals formed the margins of a
  source × kind table (#523 J)
  ([allocations.md § In the evidence report](./allocations.md#in-the-evidence-report)).
- **Against modelled current use** (`licenceImpact`, as before): the
  baseline as it ran, so "existing use" is what the model found holders
  use; it answers what changes tomorrow.

Both pairs apply **this application's own applied ops** (the ops its run
recorded) to the baseline, and nothing else: never another licence's
granted terms or a variation's, which count only among the other
applications (§ 4's table and page 1's combined row, above). The baseline
is the published run as it is; another application issued since isn't
folded into it.

The pair is two model runs, which a report request (a viewer's GET, a pack
draft) must not carry, so an editor runs it from the evidence report
(**Run at full authorised use**, `POST …/runs/:runId/authorised-impact`):
the board the engine builds over it, the mix and when and on which engine
are kept for that application run (`authorised_impact`, the newest only).
The pair's runs aren't stored as runs (nothing in the run list, no run
cap), so since `evidence-19` (issue #523 G2) the board records how to
re-derive them and what they give (`reproduction`, engine
`evidence/authorisedPair.ts`), and a pack's reproduction bundle re-runs
them ([§ Reproduction](#reproduction)):

- **The derivation**: the baseline run's stored input with
  `allocationMode: 'fullAllocation'`, and the application's recorded ops
  (their hash, `opsSha256`) applied to it (`authorisedPairInputs`). An
  applicant's ops are checked in their own namespace (the mask that hides
  other farms); when that would give another input than applying them plain
  (an op that adds an item under a hidden one's name or id), the pair
  couldn't be re-derived from the bundle, so it isn't built (`409`).
- **Both results digests** (`baselineResultsSha256`,
  `applicationResultsSha256`, `runResultsText` `results-1`), the same
  digest the bundle uses for the stored runs.
- **The outcome settings** it was built with (how years are classed, the
  Reserve site).
- **The mix as at the baseline**: how each registered volume the pair held
  a holder to was held, by allocation id (`kinds`), from the authorisation
  frozen with the baseline run when it was stored (migration
  `226_run_allocation_authorisation`, beside 219's holder keys), not the
  allocation rows as they are when the board is built: re-recording a
  licence as a registration after the baseline ran doesn't move the mix;
  a new baseline does. Runs stored before 226 took the authorisation of
  the rows living when it was applied (as 219 did for the holder keys).

The report reads the board only when it was run on the baseline's engine
with the project's outcome settings as they are now and records its pair;
otherwise, or without one, or when the baseline ran with no registered
volumes, a fixed row says which (*Not assessed: …*, never left out): a board
built before `evidence-19` is `stale` (*run it again*). A viewer kept from
each registered volume reads the board without its `reproduction` (the
digests would be an oracle for guessed volumes, and the kinds are by
allocation id; they are refused the bundle that uses them too). A pack
freezes whichever page 1 had when it was drafted; one drafted before
`evidence-14` has no such board and says so. Tests:
`backend/src/evidence/authorised-impact.db.test.ts` (the record, the mix as
at the baseline with its control, the stale board, and a bundle of the
report re-run offline), `packages/engine/src/evidence/authorised.test.ts`,
`packages/engine/src/evidence/authorisedPair.test.ts`,
`e2e/tests/evidence-allocations.spec.ts`.

### Sending it to the authority

Licensing build item 13 (provisional position, pre-counsel research,
2026-10-01). The pack's PDF and reproduction bundle name every water user,
so they go where s41(2) says the evidence goes, to the authority that
decides, not through the applicant (whose printable copy withholds the
others' figures, [§ Applicants](#applicants)). On an issued pack's page an
editor picks **Send to the authority…** (`POST …/packs/:packId/send`): the
members the authority confirmed as acting for it (confirmed delegates
holding editor or above, directly or through the team,
`app_authority_members`, 229; a proposal gets nothing), all of them or those
picked, never the sender, each get an email (`pack_sent`) naming the pack,
its version, code and the authority, with the editor's note. The email
holds **no file and no download link**: it links the pack's page, where
the member, signed in and still an editor, downloads the PDF and bundle
through the usual one-minute signed GET, and the public verify page, so a
forwarded email opens nothing. Only an issued pack is sent (a superseded or
withdrawn one is `409`), and an id that isn't a member acting for the
authority is one refusal (`422`). The history records `pack.sent` with the
recipients' ids, the authority's name and whether a note went (never the
note). An address outside the app (the authority's general inbox) is not
offered: settings.responsibleAuthority holds none, and a link that works
without signing in would be a new way out of the app for every unit's
figures ([followups.md § Evidence report](./followups.md#evidence-report-issue-71)).
Tests: `backend/src/evidence/pack-send.db.test.ts`, `e2e/tests/evidence-pack.spec.ts`.

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
  Who signs, the registration check and the fresh code are below
  ([§ Signing](#signing)).
- **Issue.** An editor issues a signed draft. The server checks, in one
  transaction: it is a draft; the stored manifest still hashes to its
  recorded hash; the frozen report may be issued; there is a `specialist`
  sign-off of the *current* pack statement (a `review` adds to it, never
  replaces it); while the project requires it, each such signer's
  registration has a current check (`409 registration_not_checked`,
  naming them; [§ Signing](#signing)) (a new known limitation or erratum since the
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

## Signing

`167_signers`; licensing positions item 9 (provisional position,
pre-counsel research, 2026-10-01). The licensing evidence is the
**applicant's** (NWA s41(2)(a)(ii)), so the host's editors signing it would
make the authority's side its author.

- **The applicant's specialist signs.** The project owner ticks
  "Specialist for this party" on a member of an applying party
  (`project_member.specialist`, needs a party; a party change ends it): the
  registered professional the applicant appointed. They sign the **draft**
  packs of their party's applications (`app_pack_specialist`: the
  application's owner is in the same party), from the Application panel's
  "To sign as the applicant's specialist" list (the applicant shares the
  application with them, as with any consultant). They read no pack row
  (112): `app_specialist_pack` gives the sign-off what it needs (lifecycle,
  the runs' identity, stamp and digest), never the manifest. Editors still
  draft and issue, and may still sign.
- **Kinds.** `signoff.kind`: `specialist` ("Specialist for the
  applicant": the professional statement issue needs) or `review`
  ("Reviewed for the responsible authority": an editor's optional second
  sign-off, never enough on its own). A specialist signs only as
  `specialist`; a run's sign-off is always `specialist`. Verify and the
  sign-off lists print the kind.
- **The registration check.** Someone at the host looks the signer up on
  the public SACNASP or ECSA register, and an owner, or an editor the
  authority confirmed as acting for it (`app_acts_for_authority`, 163,
  229), records what they found on the
  Project page's Registration checks panel
  (`POST /projects/:id/members/:userId/registration-checks`,
  `app_record_registration_check`; insert-only). A check is current for a
  year, while it is the latest for that registration in that project and
  says "registered". At issue each sign-off is bound to its signer's
  current check (`signoff_registration_check`), and verify then says
  "checked against the register by <org>, <date>"; every other
  registration reads "self-declared". The app checks nothing itself, and
  the operator never checks for the host: that would be an assurance the
  Terms disclaim. While `project.require_registration_check` is on (the
  owner's switch, on by default; `REGISTRATION_CHECK_REQUIRED=false` turns
  enforcement off for the tests and the e2e server only, and Lambda refuses
  it), issue waits until each `specialist` signer of the current statement
  has a current check.
- **A fresh code.** A sign-off, issuing and withdrawing need a code from the
  authenticator within the last 10 minutes, and an authenticator before a
  first sign-off ([security.md § Two-step sign-in](./security.md#two-step-sign-in)).
- **What the sign-off is.** The dialog and Terms §3 say: "This sign-off is
  an electronic professional statement in this app. It is not your
  signature on any form or report the authority requires; sign those as
  the authority asks." (ECTA s13(1) would want an advanced electronic
  signature wherever a law requires one.)

Tests: `backend/src/evidence/specialist-signers.db.test.ts` (who may sign
as what, each with its control; the check's writers, readers, currency and
binding; verify; the owner's switch), `evidence/packs.db.test.ts` (issue
refused until the signer is checked), `auth/stepUp.db.test.ts` (the fresh
code), e2e `registration-checks.spec.ts`.

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

- **Licence issued**: the licence's expiry date (NWA s28(1)(e), at most 40
  years) **+ 3 years**, for a professional-negligence claim on the
  assessment (Prescription Act s11(d), s12(3)).
- **Licence refused, application rejected, not considered, or application
  withdrawn**: the outcome's date **+ 3 years** (PAJA's 180 days, Water
  Tribunal appeals and prescription). The outcome words are the authority's
  (D14, as an application's decision records them; 233, issue #523 G9 (b));
  the withdrawal is the applicant's, which the authority doesn't decide.
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

**The download** (`GET …/packs/:packId/pdf`, viewers of the pack; not a
viewer kept from each farm's volume, for a pack drafted before
`evidence-15`, [§ Reproduction](#reproduction)) is a
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

**Who downloads it.** Editors and owners; a viewer too, unless the project
keeps each farm's registered volume from its viewers (decision D3,
`project.allocations_viewer_units` off, the default:
[allocations.md § Who sees what](./allocations.md#who-sees-what)) and the
pack's runs carry a registered volume. The bundle holds both runs' stored
inputs (`model.allocations`: each farm's volume, by unit) and results (the
per-unit `summary.allocations`), and redacting it would break its hash, so
such a viewer gets `403` `pack_volumes_withheld` (issue #523 G1;
`packVolumesWithheld` in `backend/src/evidence/packs.ts`), and the pack page
offers no bundle or manifest download, saying why. The same viewer reads
the pack's manifest on `GET …/packs/:packId` without Appendix A.1's
allocation rows and the run summaries' per-unit part (`volumesWithheld:
true`; it no longer hashes to `manifestSha256`, which the server still
checks against the stored manifest), and is refused (`403`, the same code)
the manifest and the PDF of a pack whose frozen text names other farms'
volumes: one drafted before `evidence-15`, whose § 5 and page-1 flag name
every farm; a team scenario's whose § 5 lists a unit one by one (before
`evidence-17`) or whose changes touch a registered volume (Appendix A.2
prints the old one); and one drafted before `evidence-18` whose § 5 has an
*Other registered users* total with a registered volume: those were gated
on units over every date, so a year's total could be one holder's (#523 G),
and which years were isn't in the frozen document. An editor drafts a new
version (at `evidence-18`) for such a viewer to read. From `evidence-18`
the manifest served to such a viewer leaves out § 5's totals of other
units' registered m³ (each year, the means, the cap; their status and
modelled use stay, `othersRegisteredWithheld`), and the PDF, which prints
them, is refused: two such sums read at the same time (baseline and
application, or two water years) give the rows between them (#523 K/L/M). Its redacted manifest also leaves out the ops that set
a volume on a unit that isn't an applicant's own and an authorised volume
mix built before the 5-holder rule, and such a pack's PDF is refused
(`packWithheldPart`). The live evidence report leaves the same parts out
for them, and builds Appendix A.2's input diff without the registered
volumes of units that aren't the application's own. Contributors and farmers get `403`, a
non-member `404`, as for every pack route; share links, the verify page and
the applicant's view never offer the bundle, the manifest or the PDF.

**What it holds** (engine `packages/engine/src/evidence/bundle.ts`,
`buildPackBundle`, layout `bundle-2` since issue #523 G2; `checkPackBundle`
reads `bundle-1` and `bundle-2`):

| Entry | What |
| --- | --- |
| `bundle.json` | the index: the pack (id, version, manifest hash, short code), the engine, each run's id, engine and **results digest**, the headline pair's two results digests (`headline`, `bundle-2`; null without a recorded pair), and the SHA-256 of every other entry |
| `manifest.json` | the manifest as its RFC 8785 text: its SHA-256 *is* the manifest hash |
| `runs/<run>/input.json` | the run's stored input snapshot (`model_run.inputs`: settings, model, each input series' first day, length and hash, and, when the run had them, `seriesChoice`, the CHIRPS series it read and the others at the outlet and at each land unit, a forecast run's `forecastRainSource`, and under `settings.rainStations` the rainfall stations' details, `stations`, engine ≥ 1.91.0: the re-run passes them back to the engine, which reads them, `bundleRunInput`; a station's record and the CHIRPS at its cell are input series like any other, `rain_station_mm#<id>` and `rain_chirps_station_mm#<id>`), `<run>` `baseline` and, for an application, `application` |
| `runs/<run>/results.json` | the run's stored summary and the SHA-256 of each daily output (results `results-1`) |
| `series/<sha256>.csv` | each input series' values, `date,value` one row a day, a missing day empty, named by the SHA-256 of the values (runs that share a series share its file) |
| `scenario.json` | the application's scenario as its run recorded it: the ops, their hash, the base run (application packs only) |
| `README.md` | how to reproduce it, and which engine to check out; and, when a run's input series hold rain from ERA5-Land or IMERG Late (`settings.gapRain`) or its forecast came from an ECMWF ENS feed, or its GR4J read AgERA5's or NASA POWER's reference ET (the run's `et0Products`, R5-E), a **Data credits** section with each source's credit word for word (engine `bundleRainCredits`, issue #604 R4-E; docs/data-sources.md). The manifest itself lists no data sources: the report it carries and the runs' inputs name them |

The **results digest** of a run is the SHA-256 of `runResultsText`: RFC 8785
JSON of the first day, the summary as JSON stores it, and each daily output's
node, key and values hash, sorted (labels aren't in it). Two runs with the
same digest have the same summary and the same value on every day of every
output. Everything the engine scores is in the summary and so in the digest:
the calibration statistics and, from engine 1.90.0, each gauge record's fit
check inside the network (`plausibility.gauges[].fit`, NSE, KGE and PBIAS,
model.md §2.10k), so a pack carries them and `reproduce:pack` re-derives
them with the run. The bundle is deterministic: entries sorted, fixed timestamps, so the
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
| `archive`, `files` | the zip reads, `bundle.json` names the pack and its baseline run, every entry is listed in `bundle.json`, and each matches its SHA-256 there |
| `structure` | fails only for a malformed bundle: a file that matches its hash but isn't what its name says (JSON that doesn't parse, a manifest or results file missing a part). `checkPackBundle` never throws for a bad bundle; this is the check that says so |
| `manifest` | `manifest.json` is canonical and hashes to the pack's hash (and to `--expect`, the hash verify returned) |
| `figure:locality` | § 1's locality map drawn again from the manifest's features (this checkout's `localityMapSvg`) hashes to the `svgSha256` the manifest names; only for a pack with a locality map (`evidence-12`); drawn with other drawing rules, it names the engine to check out |
| `observations:s2`, `observations:wofs` | § 7's observed wet days of that source classify again from the dates the manifest freezes (`checkDamObservationsBySource`): each dam's wet, dry and inconclusive counts under the source's rule, the dates ISO, in order and inside the period, the period the baseline run's as `identity.baseline` records it, the counting version (naming `builtBy` when it differs), the rule's numbers and the source's credit (Sentinel-2's with the years of its dates); only for a pack with § 7 from `evidence-24`. A pack with § 7 from `evidence-21` to `evidence-23` has `observations:wofs` alone, WOfS's counts under its one rule (`checkDamObservations`), as before ([§ Observed wet days](#observed-wet-days)) |
| `observations:days` | § 7's dates either source saw count again from both sources' frozen dates, each read by the first source (Sentinel-2, then WOfS) that calls it wet or dry; only for a pack with § 7 from `evidence-24` |
| `climate:delta` | § 8's future yield (`evidence-23`): every pair run again from the manifest's frozen factor table on the bundle's baseline and application inputs (`checkFutureYield`) gives the historical pair, every case and every range the manifest carries; another builder version names `builtBy`, another engine the runs' one. With `--no-run`, only the factor table is read. Only for a pack with a § 8 result ([§ Future yield](#future-yield)) |
| `runs` | the runs are the ones the manifest names, with its engine versions |
| `inputs:<run>` | each series file parses, matches its hash and the manifest's list; the baseline's settings and model are the manifest's |
| `changes`, `scenario` | the application's inputs differ from the baseline's by exactly the changes the manifest lists, and the scenario's ops hash to the hash it names (application packs) |
| `results:<run>` | the stored summary is the manifest's, and `results.json` gives the digest `bundle.json` names |
| `reproduce:<run>` | re-running the run's input with this checkout's engine gives the same results digest (skipped with `--no-run`) |
| `headline` | application packs: the manifest's headline board records its pair (`evidence-19`) with the digests `bundle.json` names, the application's ops hash and the baseline's engine, and the full mix built again from the baseline input's registered volumes and the recorded kinds (as at the baseline) is the manifest's. Passes with *headline not included (older pack)* for a `bundle-1` bundle or a board built before the pair was recorded, and with *no headline board to re-run* when page 1 has none |
| `reproduce:headline` | the pair re-derived from the bundle (the baseline input at `fullAllocation`, `scenario.json`'s ops on it) and re-run with this checkout's engine gives both recorded results digests, and the board built again over it is the manifest's (skipped with `--no-run`) |

The folded mix a restricted viewer reads isn't checked: it counts holders by
219's salted keys, which never leave the server. It exits 0 when every check passes, 1 when any fails (naming what differs:
the summary's paths, the daily outputs), and 2 on a usage error. A run made
with another engine version is expected to differ: the output says which
engine to check out. Tests: `packages/engine/src/evidence/bundle.test.ts`
(round trip, determinism, and each tampering beside a positive control),
`packages/engine/src/zip/zip.test.ts`,
`scripts/reproduce-pack/reproduce-pack.test.ts` (with the headline pair: a
tampered digest fails, an older bundle passes with the note) and, against
the database and MinIO, `backend/src/evidence/packs.db.test.ts` (issue,
download, reproduce both a baseline and an application pack; the setter's
refusals) and `backend/src/evidence/authorised-impact.db.test.ts` (a bundle
of a report with a recorded pair re-runs it offline).

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
   it; the re-runs are `reproduce:<run>`, `reproduce:headline` and § 8's
   `climate:delta`, `isRerunCheck`), or `no_bundle` (a pack issued without one). With it go the engine
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
pack is issued and has a live link (`app_pack_commentable`), and anyone
else signed in through the link itself, with no role in the project
(166_public_participation, [scenarios.md § Sharing and
comments](./scenarios.md#sharing-and-comments-wp-315)); editors and the
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
| their own units: supply and reliability, baseline beside application, with the change and its band | § 4's users, **frozen at issue**: the units the pack's report counted as the applicant's (`users[].own`, hashed into the manifest), within the application's stored own nodes (frozen at submit), and the nodes its proposals add. A farm the applicant sells or unlinks afterwards stays theirs by name in this copy (164; provisional position, pre-counsel research, 2026-10-01: the copy belongs to the application, not to whoever holds the land now) |
| the other farms and water users downstream of the application: "Farm 3", "Water user 1", its change in share of demand supplied in whole percentage points | § 4's users (135_pack_security), only those the applicant's results view lists (downstream of their own and added nodes in the application run's stored model, `downstreamOf`), under the anonymous names `/base` and the results view give them (`projectBaseForApplicant`), so the pack adds no unit, and no link between a name and a place, the applicant doesn't already have. The manifest holds no network, so the set comes from the run's stored model and the names from the frozen own units (as the results view names them while nothing changed hands); when the run's base is no longer a published run, none are shown and the view says why. Upstream and side-branch units never appear |

No units at all when the report changed a baseline assumption (the figures
that move with it could read another unit's values out, as for the
applicant's results, 118). Never another unit's name, id, demand, volumes or
reliability, the registered volumes or holders, the other applications, the
flags and questions, the settings, model, input diff, series hashes,
warnings or the applicant statement, and no person but the signers. **Not
the PDF, the manifest or the bundle:** each carries the whole report, which
is the assessors' copy (an applicant checks any copy they are handed on the
verify page).

**Their printable copy** (165_applicant_copy; provisional position,
pre-counsel research, 2026-10-01). R267 reg 11(1) has the applicant file the
technical report, and what they file reaches the interested and affected
parties (Annexure D item 8), so the copy they file should withhold the
other water users' figures. A party of the application asks for it on their
pack view (**Make a printable copy**, `POST …/scenarios/:sid/packs/:packId/pdf`);
an `applicant_pack_render` job, as them, prints that very view in the same
headless Chromium as the pack's PDF ([§ The PDF](#the-pdf)): a render token
of purpose `applicant_pack`, issued only to a party (`render_token_issue`:
`app_applicant_pack_meta`), whose session reads that one page and nothing
else (not the editor's pack route, the run or the application;
[security.md § Render tokens](./security.md#render-tokens)). The PDF goes
beside the pack's own under `packs/<project>/<pack>/applicant/<sha256>.pdf`
and is recorded once with **its own** SHA-256, pages and time
(`evidence_pack_applicant_copy`, written only by
`app_record_applicant_pack_pdf` from the party's own running job); asking
again changes nothing. `GET …/pdf` downloads it (a one-minute signed GET,
`evidence-pack-v<n>-<code>-applicant-copy.pdf`). The printed page opens with
"Applicant's copy: other water users' figures withheld. Not the pack. Check
the pack at <verify address>", with the pack's code and manifest hash, and
its footer says the same on every page. It is not hashed as the pack, never
replaces the pack's PDF, and verify knows nothing of it: the authority
checks the pack itself. In production the job hands the render to the
renderer Lambda with the application's id (`render_pack` with
`scenarioId`), which answers `copy: 'applicant'`; the worker records it once
the packs bucket is seen to hold it, as for the pack's PDF.
Tests: `backend/src/evidence/applicant-copy.db.test.ts` (who asks and
downloads, the token's issuer, the render session swept over every route,
the one record, the production answer), `backend/src/jobs/handlers/applicant-pack-render.test.ts`,
`backend/src/reports/scope.test.ts`, and `e2e/tests/applicant-pack.spec.ts`
(the real print through MinIO, its hash checked).

**Share links.** The application's owner (not the consultant they shared it
with) makes a link to their own pack while it is issued, and lists and
revokes the links they made, whatever its standing, while they are still
its party; the editors still list and revoke every link. Someone who made a
link as an editor and was demoted since, and isn't a party, no longer sees
or revokes it. The link shows the public projection above
([§ Sharing and comments](#sharing-and-comments)), which names no unit, the
applicant's own included.

**The decision, its terms and what followed** (227_licence_terms,
228_decision_events, issue #523 G3, G4). On the Application panel the
applicant reads the authority's decision, the licence's granted terms (as
applied for, or the changes as licensed, naming only their own units; a
neighbour's is an anonymous farm to them, as in their base) with its
conditions, and the appeal events recorded after it (lodged, upheld, set
aside, varied, with a variation's terms), with a line saying whether the
licence counts in cumulative assessments now. They come with the scenario
(`GET …/scenarios/:sid`): the events table's policy asks the scenario's own,
so whoever reads the application reads them and nobody else does. Only a
member acting for the responsible authority records any of them.

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
unit; the applicant's farm, unlinked after issue, is still theirs by name in
the pack while the results view, which follows the links, no longer names
it).

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
- `signoff_pack_draft` refuses a sign-off of a pack that isn't a draft. It
  reads the pack row `FOR SHARE` (288_signoff_pack_lock): the applicant's
  specialist signs without locking the pack (they read no pack row), so
  without the lock a sign-off sent during an issue went in after it, a
  signer issue never checked. Now it waits for the issue, then is refused
  (`evidence/signoff-issue-race.db.test.ts`, with its control).
- `app_record_pack_pdf` records a PDF only from its pack's running render
  job, under the key it derives, once ([§ The PDF](#the-pdf)).
- Tests: `backend/src/evidence/packs.db.test.ts` (each refusal with its
  positive control, the PDF's lifecycle and the bundle's setter), `jobs/handlers/pack-render.test.ts`,
  `e2e/tests/evidence-pack-pdf.spec.ts` (the downloaded bytes hash to the
  recorded SHA-256), `packages/engine/src/evidence/pack.test.ts` (the
  manifest is deterministic, key order doesn't matter, a changed setting
  changes the hash, the lifecycle is outside it), the catalogue, role-ladder,
  mass-assignment and cross-project sweeps.
