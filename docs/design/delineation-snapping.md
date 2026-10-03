# Research: putting a click on the DEM's channel

Why a click on a river line can land in a gully, what the literature does
about it, and what each way of moving a click onto the channel gets right on
real South African rivers. Written for issue #374; the rules it led to are
built in `backend/src/delineation/place.ts` (Delineate `delineate-2`,
Sub-catchments `start-3`, and Start and Divide only since `start-7`: until
then they snapped every point 150 m, the hydrologist's review finding 3) and described in
[maps.md § Delineation](../maps.md#delineation) and
[delineation.md § Method](./delineation.md#method). Measured 2026-10-02.

## The problem

Delineate and Sub-catchments route flow on the DEM (Copernicus GLO-30, via
the Mapterhorn build), but an editor clicks on a *river line*: HydroRIVERS
on the River network layer, or the basemap's OpenStreetMap water. The line
and the DEM's channel disagree. Until `delineate-2` the server moved a click
to the most-drained cell within 150 m and stopped there, so a click whose
channel lay further away took a gully next to it, silently.

The case that started it: a Delineate click on the mapped Orange at
Upington (21.4656° E, 28.3887° S) was accepted as a **0.17 km²** catchment
boundary beside a HydroRIVERS reach of **343 037 km²**. Measured there:

- The most-drained cell within 150 m drains 0.2 km² (a bank gully), within
  300 m 0.3 km²; the routed Orange channel is **504 m** away.
- A north–south profile through the click: the GLO-30 Water Body Mask's
  river, flattened at 804 m, lies 300–500 m north; the click is at 812 m on
  unedited land (Edit Data Mask 1), though the basemap's water polygon
  covers it. The nearest mask river pixel is **306 m** away.

## Sources

- **Snap Pour Point** (the old rule): the cell of highest flow accumulation
  within a snap distance ([ArcGIS Pro](https://pro.arcgis.com/en/pro-app/2.9/tool-reference/spatial-analyst/snap-pour-point.htm);
  WhiteboxTools `SnapPourPoints`). When the true channel is beyond the
  distance it picks the best cell inside it, with no signal.
- **Jenson's snap**: the *nearest* cell of a stream raster (an
  accumulation threshold) within the distance. WhiteboxTools' own docs
  (Lindsay, its author) recommend it over Snap Pour Point because the
  largest-accumulation rule "may re-position outlets on the main-trunk
  stream" near confluences ([`jenson_snap_pour_points.rs`](https://github.com/jblindsay/whitebox-tools/blob/master/whitebox-tools-app/src/tools/hydro_analysis/jenson_snap_pour_points.rs);
  Jenson 1991, *Hydrological Processes* 5). Note: WhiteboxTools searches a
  box of half the stated snap distance.
- **Lindsay, Rothwell & Davies (2008)**, *Mapping outlet points used for
  watershed delineation onto DEM-derived stream networks*, WRR 44, W08442
  (abstract only; [NORA](https://nora.nerc.ac.uk/id/eprint/4003/)): station
  positions "commonly do not coincide" with DEM streams; their AORA uses
  **water-body names** to reposition outlets and halved the errors of the
  next-best method on 993 stations. (Issue #374 first said AORA matches by
  area: it doesn't.)
- **Lehner (2012)**, GRDC Report 41, the allocation of GRDC gauging stations
  to HydroSHEDS, as restated by [Burek & Smilovic (2023), ESSD 15, §2.1.1](https://essd.copernicus.org/articles/15/5617/2023/):
  a ~5 km search; cells whose upstream area differs from the station's by
  more than 50 % are dismissed; the rest ranked by **OC = RA + 2·RD**, RA =
  100 − the area accordance (%, 0–50), RD = the distance scaled 0 at the
  station to 50 at the radius; none passing, the search widens to ~10 km
  with OC = RA + RD. Burek & Smilovic report 0.7–2 % station mismatches at
  coarse resolutions with a refined version.
- **Copernicus DEM Product Handbook v5.0** (Airbus, 2022): GLO-30 is a
  **DSM** (buildings, vegetation) derived from WorldDEM with "flattening of
  water bodies and consistent flow of rivers"; relative vertical accuracy
  < 2 m on slopes ≤ 20 %; a **Water Body Mask** (0 none, 1 ocean, 2 lake,
  3 river) and an Edit Data Mask (10 river, 7 flattened) ship with every
  tile. Both are on the public AWS copy
  (`copernicus-dem-30m/…/AUXFILES/…_WBM.tif`). Licence (the tile's
  `eula_F.pdf`, Art. 4–6): free, adaptation allowed, with the Art. 6(b)
  notice for modified data, the same terms the app already meets for the
  relief and delineation.
- **HydroRIVERS v1.0 technical documentation**: lines are traced through
  HydroSHEDS' **15″ (~500 m) cells**, streams starting at 10 km² or 0.1 m³/s;
  smaller ones are "increasingly unreliable in their spatial
  representation". So a HydroRIVERS line is a cell-centre path, not a
  channel centreline.
- **HydroSHEDS v1.4 technical documentation § 3.4.3, stream burning**: rivers
  burnt **12 m deep, tapering to 2 m over a 0.005° (~500 m) buffer**, lakes
  14 m within 0.0025°, only large rivers, "to avoid excessive alterations";
  in steep terrain the burn hardly changes the surface.
- **Conditioned products considered**: [MERIT Hydro](https://global-hydrodynamics.github.io/MERIT_Hydro/)
  (3″): CC-BY-NC 4.0, or ODbL 1.0 under which "derived data based on MERIT
  Hydro must be made publicly available under the same ODbL license" (a
  commercial service's delineations would have to be published): **not
  usable**. [HydroSHEDS v2](https://hydrosheds.org/hydrosheds-v2) (30 m
  TanDEM-X, conditioned with water masks and OSM): Americas only so far.
  HydroSHEDS v1 (3″, conditioned, licence already reviewed in maps.md §
  Sources): 90 m.
- **OSM waterways for burning**: the ODbL's share-alike on a derivative
  database. The OSMF [horizontal layers guideline](https://osmfoundation.org/wiki/Community_Guidelines/Horizontal_Map_Layers_-_Guideline)
  covers visual 2D maps only, and neither it nor the collective-database
  guideline addresses elevation data derived with OSM water; **unresolved**,
  a question for counsel before any OSM burn.

## The experiment

`backend/scripts/research/snap-methods.ts` (run by hand, not in CI; the
header says how) samples HydroRIVERS reaches inside South Africa from the
operator's loaded `HydroRIVERS-v10` in four classes by upstream area: 60
each of 10–100, 100–1 000 and 1 000–1 500 km², and 40 main stems (Strahler
≥ 7, ≥ 20 000 km²), in a fixed pseudo-random order (seed `snap-1`). For
each it clicks the reach's vertex next to its downstream end (where an
editor clicks the line), routes one 2 048-cell window (~68 km, zoom 11,
~33 m cells) with the app's own fill, D8 and accumulation, and applies
every method to that routing. The reference is the reach's own upstream
area (`UPLAND_SKM`): independent of the GLO-30 routing, but not ground truth
(HydroSHEDS 15″).

Scoring: **right** within ½–2× the reference; **gully** under 0.1×; short
0.1–½×; jump over 2×; a catchment cut at the window under ½× is
inconclusive (its area is a lower bound). Main stems can't fit a window, so
a pick there is right when it is **on the trunk** (at least half the biggest
accumulation within 1 km). The area matches use the reference itself, so
they are also checked for landing **over 1 km from the reach's own line**
(likely another river with a similar area).

Methods: M0 the old rule (most-drained within 150 m); M1 the same within
300/500 m; M2 Jenson, the nearest cell of ≥ 1 or ≥ 10 km² within 500 m; M3
the best area match within 1/2.5 km; M3L Lehner's OC ranking within 1/2.5
km; M4 M0 plus the guard (flag when a channel with 100× the cells is within
1 km); M5 the most-drained cell holding a Water Body Mask pixel within
500 m, else M0.

## Results

How far the DEM's matching channel (the nearest cell within 50 % of the
reference area) lies from the clicked line: a **median of 150–260 m**, the
75th percentile 300–550 m, the 90th **1.2–1.5 km**. Beyond 150 m for
49–61 % of reaches. The old rule could only find it for the rest.

Right placements (the full tables, with the wrong and flagged shares, are
in the appendix):

| Method | small (60) | medium (60) | large (60) | main stems (40) |
| --- | --- | --- | --- | --- |
| M0 most-drained within 150 m (the old rule) | 35 % (57 % gullies) | 43 % (45 %) | 37 % (48 %) | 48 % on the trunk |
| M1 most-drained within 500 m | 55 % (22 % jumps) | 63 % | 62 % | 98 % |
| M2 Jenson nearest ≥ 10 km² within 500 m | 53 % | 62 % | 55 % | 88 % |
| M3L Lehner within 1 km (rest: no match) | 87 % (0 % wrong) | 78 % (0 %) | 67 % (0 %) | no match (areas don't fit a window) |
| M3L Lehner within 2.5 km | 93 % (7 % > 1 km off the reach) | 88 % (5 %) | 78 % (8 %) | no match |
| M4 guard: of M0's wrong placements, flagged | 76 % (5 % false alarms) | 61 % (0 %) | 74 % (0 %) | 90 % (0 %) |
| M5 water-mask snap within 500 m | 35 % | 43 % | 38 % | 80 % |

Findings:

1. **The old rule was wrong more often than right** (57 % of all 220, half
   of them gullies), and never said so.
2. **Matching the reach's upstream area within 1 km (Lehner's ranking)
   placed 67–87 % right and none wrong**: every miss was "no cell within
   50 %", a known failure the caller can handle. Ranking by area alone
   (M3) moved clicks a median ~1 km and, at 2.5 km, onto another river
   20–57 % of the time: the distance term is what keeps it on the clicked
   river. At 2.5 km Lehner's own ranking still lands 5–8 % on other rivers;
   1 km is the safe radius.
3. **The guard catches most of what's left** (61–90 % of the old rule's
   wrong placements, 0–5 % false alarms). On main stems, where no area can
   be matched, it is the only signal, and it caught 90 %. The cell it
   offers carries at least half the biggest accumulation within 1 km, so
   it is on the trunk by construction; whether that trunk is the clicked
   river is the editor's check (the most-drained cell within 500 m, M1, was
   on the trunk for 98 % of main-stem clicks).
4. **Widening the snap trades gullies for jumps** (22 % of small reaches
   jumped onto a larger river at 500 m), as WhiteboxTools' docs warn: not
   safe as a silent rule.
5. **The water mask only helps main stems**: it lies within 1.2 km of 63 %
   of main-stem clicks (median 48 m) but of 20–27 % of the others, mostly
   far.

**As built** (M3L within 1 km when a reach is within 1 km, otherwise M0 with
the guard), on the same 220:

| Class | Placed right | Flagged, the channel offered | Wrong, not flagged | Inconclusive |
| --- | --- | --- | --- | --- |
| small (60) | 87 % | 8 % | 5 % | 0 % |
| medium (60) | 78 % | 7 % | 15 % | 0 % |
| large (60) | 67 % | 13 % | 12 % | 8 % |
| main stems (40) | 48 % | 48 % | 5 % | 0 % |
| **all (220)** | **72 %** | **16 %** | **10 %** | 2 % |
| the old rule (all 220) | 40 % | – | 57 % | 3 % |

Silent wrong placements fall from 57 % to 10 %. The offered channel is the
guard's nearest trunk cell, not the most-drained one: the most-drained cell
within 1 km lies downstream at the circle's edge (971 m on the synthetic
DEM's valley), which would move the outlet down the river.

## Burning the water mask (second experiment)

`backend/scripts/research/snap-burn.ts` burns the GLO-30 Water Body Mask into
the DEM before routing, with HydroSHEDS v1.4's recipe (river pixels lowered
12 m, tapering to 2 m at ~500 m; lakes 14 m within ~250 m), then applies the
old snap at the same click.

- **The Upington click**: still a gully (0.18 km² unburnt, 0.09 km² burnt).
  The burn moves the routed channel onto the mask's river, but that is
  306 m from the click, beyond the 150 m snap: burning alone doesn't fix a
  click on a displaced line; the placement has to reach the channel.
- **Small reaches with mask pixels nearby** (the first 8 of them): 6 gave
  the same area burnt and unburnt, one changed by a cell, and **one got
  worse**: a right placement (19 km² against HydroRIVERS' 14 km²) became a
  0.03 km² gully, the burn drawing the flow towards the mask's river and
  away from the clicked stream. The mask's rivers are the big ones; near
  them, burning can pull a small stream's click onto the wrong channel.
- **Large reaches and main stems** (41 with mask within 1.2 km, one more
  skipped after two dropped DEM reads): burning **fixed none and broke 3**.
  Large reaches: 7 of 15 right unburnt, 5 burnt; main stems on the trunk:
  12 of 26 unburnt, 11 burnt. Two thirds of them came out with the same
  area either way.

**Conclusion: don't burn the mask.** With the old snap it never helped and
sometimes pulled a click onto the wrong channel; the placement rules above
fix the cases it was meant to.


## Confluences (third experiment)

**What the first experiment missed.** It clicked each reach a cell above its
lower end and scored the result against that same reach, so it never asked
which of several rivers a click at a junction means; its "more than 1 km off
the reach" check measured against the reach already chosen, so a wrong
choice of reach could not fail it. The operator found it: a gauge on a
junction (21.2608° E, 28.3262° S) was 32 m from a 67 km² tributary, 92 m
from the 422 km² river above the junction and 102 m from the 497 km² river
below it; the nearest line won, and Delineate gave a sound 66 km² catchment
of the wrong river. WhiteboxTools' docs warned of exactly this ("outlet cells
… near the confluence point of smaller tributary streams"); the warning was
applied to the snap rule and not to the choice of reach.

`backend/scripts/research/snap-confluence.ts` clicks 30–50 m off 60 real
HydroRIVERS junctions where reaches of clearly different areas meet (≤ 1 500
km², seed `confluence-1`):

- **The nearest line is a coin toss:** it picked the river below the junction
  at 25 junctions, the main river above it at 18 and the tributary at 17.
- **The ambiguity is seen at all 60** (reaches within 200 m differing by
  1.5×): the server now answers 422 `confluence` with each river, and the
  editor picks.
- **Matching the picked river by area isn't enough.** Within 1 km, 76 % of
  the 180 river choices landed within ½–2× of their area (15 % wrong
  unflagged); within 2.5 km, 89 % (7 %). But area can't tell the river below
  from the main river above, which differ only by the tributary: matched by
  area, the two landed on **the same cell at 29 of 60 junctions (48 %)**, so
  for one of them the editor's pick was silently ignored.
- **The DEM's own junction (`junction.ts`)**: match the tributary (its area is
  distinct), follow it downhill to where an inflow of at least half the main
  river's area joins (capped at a quarter of the window's area), and that is
  the junction: the river below is that cell, each river above its own
  branch's last cell before it. Found at 50 of 60 junctions; at **all 50**
  the river below came out as the main river above plus the tributary
  (within 5 %), i.e. on the right side. Its ½–2× score is lower (77 %) because
  the DEM's and HydroRIVERS' areas disagree on large rivers, not because of
  sides.
- **As built:** the junction where found, else the area match within 2.5 km
  (the river having been named, the wider radius measured better): 85 % of
  river choices within ½–2×, 3 % flagged, 12 % not.

## Gauges (fourth experiment)

**Why.** The first three experiments clicked HydroRIVERS vertices and
junctions and scored each result against HydroRIVERS' own area, so a rule
that agrees with HydroRIVERS scored well even where both are wrong, and no
click was where a gauge actually sits (issue #390). This one clicks real
gauging stations at their published positions and scores against their
published catchment areas, which come from neither HydroRIVERS nor GLO-30.
Measured 2026-10-03.

**The reference.** The DWS station catalogue (the issue's first choice)
answers HTTP 403 outside South Africa. Candidates checked:

- **GRDC station catalogue** (`GRDC_Stations.xlsx`, the 2025-07-24 edition,
  from GRDC's public FTP): 451 South African stations, 446 with a catchment
  area, coordinates to the second of arc for most. GRDC holds them "with
  permission of the data owners, usually the National Hydrological
  Services", so the area is DWS's published one. Terms
  ([data policy](https://grdc.bafg.de/about/data_policy/)): no commercial
  use, no redistribution, inform GRDC of publications. **Chosen.**
- **GRDC-Caravan** (Färber et al. 2025, ESSD 17, CC BY 4.0) includes South
  African stations, but its catchment areas come from GRDC's boundaries,
  delineated on HydroSHEDS: not independent of HydroRIVERS.
- **GSIM** metadata (CC BY 4.0) carries the reported area too, but its South
  African stations come from GRDC, and its own estimate is HydroSHEDS-based.
- **WRC reports** (WR2012) give quaternary areas, which the persona run
  already used (reviews/persona-hydrologist.md); they aren't gauges.

So the run is research use, offline: the catalogue and the per-station
results stay in `~/.cache/water-management-gauges/` on the operator's
machine, and only the aggregates below are committed (CLAUDE.md rule 11).
The roadmap's decision D11 (docs/roadmap/international.md) keeps GRDC data
out of the product ("validation only, offline, with permission"): the
operator should tell GRDC about this use (grdc@bafg.de) as its policy asks.

**The harness.** `backend/scripts/research/snap-gauges.ts` (run by hand; the
header says how) clicks each station at its published position and runs the
app's Delineate path: `reachFor` (the nearest HydroRIVERS reach within 1 km,
or the confluence question) and `delineate` (the 1 024 → 2 048 → 3 072-cell
ladder, `place`'s area match or snap with the guard, `junctionOutlets` at a
confluence). At a confluence an oracle picks the river whose area is nearest
the published one, the best an editor who knows the gauge's river can do. A
`larger_channel` refusal is followed as "Use that channel" does. Delineate's
20 s budget is lifted, so no refusal comes from this machine's clock. Every
failure is routed again at the 3 072-cell window for a diagnosis, and
`--shift` reroutes each `too_large` refusal with the window moved towards
the cut catchment. All 446 stations lie inside the local GLO-30 extract.

**Results** (½–2× of the published area counts as right):

| Published area | n | ½–2× | accepted outside ½–2×: silent / with the caveat | refused (`too_large`) | asked a confluence | matched / junction / snapped | median ratio (accepted) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| < 100 km² | 96 | 84 (88 %) | 8 / 1 | 3 (1) | 6 | 68 / 4 / 21 | 0.99 |
| 100–1 000 km² | 155 | 138 (89 %) | 7 / 1 | 9 (7) | 9 | 137 / 6 / 3 | 1.00 |
| 1 000–10 000 km² | 129 | 18 (14 %) | 8 / 5 | 98 (94) | 4 | 23 / 1 / 7 | 0.99 |
| ≥ 10 000 km² (main stems) | 66 | 0 | 2 / 2 | 62 (52) | 6 | 2 / 0 / 2 | 0.00 |

By the published position's distance from the nearest HydroRIVERS line:
285 within 150 m, 127 at 150–500 m, 17 at 500 m–1 km and 17 beyond 1 km
(where the app has no reach and only snaps). Results get worse with
distance: 55 %, 50 %, 35 % and 71 % right (the last are mostly small coastal
catchments, where a snap within 150 m happens to be right). A reported
coordinate rounded to two decimals (±0.6 km) is enough to leave the river.

1. **Under 1 000 km², where the catchment fits the window, the app is right
   88–89 % of the time**, and a matched point's area follows the
   published one, not HydroRIVERS'. On the 228 matched points HydroRIVERS
   runs 0.97–1.04–1.55× the published area (p10–p50–p90) and the app
   0.92–1.00–1.02×. Where HydroRIVERS is 10–100 % off (64 stations, mostly
   over: the reach's area is at its downstream end, the gauge part-way up),
   the app is within 10 % at 51. The area match picks the cell at the gauge
   (within 50 % of the reach's area), and the distance term keeps it from
   sliding down to the reach's end: 6 of 58 slid past 1.1×. This mostly
   answers persona finding 13 (a click mid-reach sliding downstream) for
   these sizes.
2. **The biggest failure is the window: 94 of 129 gauges of 1 000–10 000 km²
   are refused `too_large`**, and 7 of 155 under 1 000 km². Every window is
   centred on the click, so it reaches only half its side (~48 km) towards
   the catchment (persona finding 6). Moving the 3 072-cell window towards
   the cut catchment, up to three times, made 59 of the 102 refusals below
   10 000 km² whole, all 59 within ½–2× (median 1.00×); 43 stay cut (longer
   than the window, the durable-path follow-up for large catchments). 64 of
   the 102 touched only one side of the click-centred window.
3. **The nearest line is often the wrong stream, and the area match obeys
   it silently** (18 of 380 below 10 000 km², 17 of them without a caveat):
   - **9 gauges on a river, beside a smaller stream's line:** a cell within
     150 m of the gauge drains the published area, but the nearest reach is
     a tributary's, so the area match moves the point onto the tributary
     (areas of 0.01–0.1× the published one, moved 30–900 m). 9 of 9 lie within 1 km of
     a HydroRIVERS junction, beyond the 200 m that asks which river.
   - **4 gauges on a small stream beside a larger river's line:** moved onto
     the river (2.7–7.8×; persona finding 4).
   - 5 more where another reach within 2 km matches the published area.
4. **The first window is too small for some rivers** (persona finding 1):
   3 gauges of 440–3 800 km² snapped to 4–164 km² with only the
   *unmatched* caveat in the 1 024-cell window, where the 3 072-cell window
   matches the reach within 200 m of the gauge; a fourth (2 359 km²) got a
   600 km² side channel at 2 048 cells. The same mechanism accepted two
   main-stem gauges (18 000 and 63 000 km²) as 195 and 268 km², caveat
   only. 8 `larger_channel` refusals below 10 000 km² quote a window-local
   "about" area (persona finding 10); "Use that channel" then gave ½–2×
   for 3 of 18 (all sizes), the rest mostly `too_large`.
5. **Off-river positions get a gully with no caveat at all**: 4 gauges more
   than 1 km from any line snapped to 0.08–0.8 km² (published 1–2 400 km²),
   with no reach to raise the *unmatched* caveat and no channel within the
   guard's 1 km (persona finding 7, which assumed a reach was there).
6. **Flat lower rivers**: 2 gauges (a Zululand coastal floodplain and a
   wide Western Cape valley) have no GLO-30 channel within 2.5 km carrying
   the river; the result (0.4 and 2 664 km² against 9 099 and 6 713 km²) is
   accepted with the caveat only. New: no persona finding covers a DEM that
   routes the river elsewhere.
7. **Main stems are refused, as designed, but with the wrong advice**: 52 of
   66 `too_large` ("pick an outlet further upstream", persona finding 11),
   10 asked `larger_channel`, and "Use that channel" then ran into
   `too_large`. 4 were accepted, all wrong: 2 silently (a nearby
   tributary's reach matched, as in 3) and 2 with the caveat (as in 4).
8. **The confluence question and the DEM's junction work at gauges**: 11
   junction placements, all 11 within ½–2× (median 0.99×).

**What it means.** For catchments that fit the window the placement rules
hold up against an independent reference. The failures are classes the
persona run named (findings 1, 4, 6, 7, 10, 11), and the gauges rank them:
the outlet-centred window (finding 6) refuses most gauges of 1 000–10 000
km², and the area match's obedience to the nearest line (finding 4, in both
directions) is the largest silent error. The fixes belong to that round;
rerun this harness after them.

## What these samples can't show (check before trusting a number)

Written after the confluence miss, so the next experiment states its blind
spots before it runs:

- **Where the clicks are.** HydroRIVERS vertices, junctions and (fourth
  experiment) gauging stations' published positions ✓; not OSM waterways,
  not the middle of a long reach far from its vertices, not dam walls.
- **What the reference is.** ✓ The fourth experiment scores against
  published gauge areas (DWS's, through the GRDC catalogue), independent of
  HydroRIVERS and GLO-30. Not ground truth either: a published area can be
  stale or rounded, and the GRDC subset (446 stations) leans to long records
  and larger rivers.
- **Which river.** The ½–2× test can't see a wrong river of similar size, or
  the wrong side of a junction; the junction run measures sides directly.
  The gauge run shows the nearest line choosing the wrong stream; a wrong
  side of a junction within ½–2× still passes there unseen.
- **Scale.** ✓ Gauges up to 10 000 km² and main stems. Most gauges of
  1 000–10 000 km² are refused by the window, so their placement is
  untested until finding 6 is fixed.
- **Which path.** Only Delineate's. Start and Divide place points their own
  way (persona finding 3) and Sub-catchments picks the lowest click; none
  was run at gauges.
- **The editor.** An oracle answers the confluence question with the right
  river; a real editor may not know it.

## Limits of this evidence

- The reference is HydroRIVERS' own area, from 15″ HydroSHEDS: a 50 %
  tolerance absorbs its error, but a reach whose HydroRIVERS area is wrong
  scores the methods wrong too.
- Clicks were on HydroRIVERS vertices only; OSM waterways (the basemap) are
  probably closer to the real channel but weren't sampled (the basemap's
  vector tiles would need decoding).
- One window size (2 048 cells): a large reach's catchment can run past it
  (the inconclusive share), and Delineate grows its window where this
  didn't.
- 220 reaches, one seed: the percentages carry about ±6–13 points (a
  binomial 95 % interval on 40–60 samples).
- The snap (M0, M1, and the fallback in the as-built rule) was measured
  with its radius counted in whole cells from the clicked cell, which
  reached up to 160–180 m against the stated 150 m on GLO-30's 31–38 m
  cells (zoom 11, by latitude).
  Since `delineate-4` / `start-5` (issue #387) it is measured from the exact
  click to each cell's centre and never exceeds the radius; the matched
  rule (M3L) always measured that way. The snap rows would come out a
  little lower on a rerun, not differently in kind.

## Not done, and when

- **Drawing the DEM's own channels** while Delineate or Sub-catchments is on
  (issue #374 item 3) would let the editor click the line the DEM agrees
  with and make the guard rarely fire. Not built here; it's the next step.
- **Burning the Water Body Mask**: measured above and rejected; nothing to
  do unless a later DEM (HydroSHEDS v2) changes the picture.
- **OSM burning**: blocked on the ODbL question above.
- **HydroSHEDS v2**: revisit when it covers Africa.

## Appendix: the full tables

Regenerate with `tsx --env-file=.env.development scripts/research/snap-summary.ts <results.json>`
(from `backend/`).

### small (60 reaches, 10–83 km²)

The DEM's matching channel (nearest cell within 50 % of the reference area, ≤ 2.5 km): found for 56 of 60; distance from the clicked line median 178 m, 75th percentile 546 m, 90th 1288 m; beyond 150 m for 61 %.
Water Body Mask pixels within 1.2 km: 13 of 60; nearest median 625 m.

| Method | ok | gully (< 0.1×) | short | jump (> 2×) | none / flagged | inconclusive | median move | ok but > 1 km off the reach |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M0 max-acc 150 m (today) | 35 % | 57 % | 5 % | 3 % | 0 % | 0 % | 136 m | 0 % |
| M1 max-acc 300 m | 57 % | 18 % | 15 % | 10 % | 0 % | 0 % | 286 m | 0 % |
| M1 max-acc 500 m | 55 % | 10 % | 13 % | 22 % | 0 % | 0 % | 483 m | 0 % |
| M2 Jenson nearest ≥1 km² within 500 m | 55 % | 12 % | 20 % | 7 % | 7 % | 0 % | 153 m | 0 % |
| M2 Jenson nearest ≥10 km² within 500 m | 53 % | 0 % | 10 % | 10 % | 27 % | 0 % | 136 m | 0 % |
| M3 Lehner area match ≤50% within 1 km | 83 % | 0 % | 0 % | 0 % | 17 % | 0 % | 846 m | 0 % |
| M3 Lehner area match ≤50% within 2.5 km | 92 % | 0 % | 0 % | 0 % | 8 % | 0 % | 976 m | 20 % |
| M3L Lehner OC=RA+2RD within 1 km | 87 % | 0 % | 0 % | 0 % | 13 % | 0 % | 177 m | 0 % |
| M3L Lehner OC=RA+2RD within 2.5 km | 93 % | 0 % | 0 % | 0 % | 7 % | 0 % | 212 m | 7 % |
| M4 today + 100× guard within 1 km | 35 % | 57 % | 5 % | 3 % | 48 % | 0 % | 136 m | 0 % |
| M5 water-mask snap 500 m | 35 % | 55 % | 5 % | 5 % | 0 % | 0 % | 139 m | 0 % |

M4's guard: flags 28 of today's 37 short or gully snaps (76 %), and 1 of its 21 right ones (false alarms 5 %).

### medium (60 reaches, 102–894 km²)

The DEM's matching channel (nearest cell within 50 % of the reference area, ≤ 2.5 km): found for 53 of 60; distance from the clicked line median 148 m, 75th percentile 295 m, 90th 1161 m; beyond 150 m for 49 %.
Water Body Mask pixels within 1.2 km: 12 of 60; nearest median 900 m.

| Method | ok | gully (< 0.1×) | short | jump (> 2×) | none / flagged | inconclusive | median move | ok but > 1 km off the reach |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M0 max-acc 150 m (today) | 43 % | 45 % | 7 % | 5 % | 0 % | 0 % | 137 m | 0 % |
| M1 max-acc 300 m | 63 % | 20 % | 10 % | 7 % | 0 % | 0 % | 286 m | 0 % |
| M1 max-acc 500 m | 63 % | 17 % | 5 % | 15 % | 0 % | 0 % | 483 m | 0 % |
| M2 Jenson nearest ≥1 km² within 500 m | 55 % | 22 % | 17 % | 3 % | 3 % | 0 % | 93 m | 0 % |
| M2 Jenson nearest ≥10 km² within 500 m | 62 % | 5 % | 17 % | 3 % | 13 % | 0 % | 107 m | 0 % |
| M3 Lehner area match ≤50% within 1 km | 75 % | 0 % | 0 % | 0 % | 25 % | 0 % | 960 m | 0 % |
| M3 Lehner area match ≤50% within 2.5 km | 87 % | 0 % | 0 % | 0 % | 13 % | 0 % | 1315 m | 28 % |
| M3L Lehner OC=RA+2RD within 1 km | 78 % | 0 % | 0 % | 0 % | 22 % | 0 % | 132 m | 0 % |
| M3L Lehner OC=RA+2RD within 2.5 km | 88 % | 0 % | 0 % | 0 % | 12 % | 0 % | 170 m | 5 % |
| M4 today + 100× guard within 1 km | 43 % | 45 % | 7 % | 5 % | 32 % | 0 % | 137 m | 0 % |
| M5 water-mask snap 500 m | 43 % | 45 % | 7 % | 5 % | 0 % | 0 % | 137 m | 0 % |

M4's guard: flags 19 of today's 31 short or gully snaps (61 %), and 0 of its 26 right ones (false alarms 0 %).

### large (60 reaches, 1002–1494 km²)

The DEM's matching channel (nearest cell within 50 % of the reference area, ≤ 2.5 km): found for 47 of 60; distance from the clicked line median 158 m, 75th percentile 481 m, 90th 1545 m; beyond 150 m for 55 %.
Water Body Mask pixels within 1.2 km: 16 of 60; nearest median 480 m.

| Method | ok | gully (< 0.1×) | short | jump (> 2×) | none / flagged | inconclusive | median move | ok but > 1 km off the reach |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M0 max-acc 150 m (today) | 37 % | 48 % | 3 % | 0 % | 0 % | 12 % | 137 m | 0 % |
| M1 max-acc 300 m | 53 % | 30 % | 2 % | 0 % | 0 % | 15 % | 283 m | 0 % |
| M1 max-acc 500 m | 62 % | 23 % | 2 % | 0 % | 0 % | 13 % | 485 m | 0 % |
| M2 Jenson nearest ≥1 km² within 500 m | 47 % | 33 % | 5 % | 0 % | 7 % | 8 % | 98 m | 0 % |
| M2 Jenson nearest ≥10 km² within 500 m | 55 % | 10 % | 5 % | 0 % | 15 % | 15 % | 92 m | 0 % |
| M3 Lehner area match ≤50% within 1 km | 65 % | 0 % | 0 % | 0 % | 35 % | 0 % | 982 m | 0 % |
| M3 Lehner area match ≤50% within 2.5 km | 78 % | 0 % | 0 % | 0 % | 22 % | 0 % | 2481 m | 57 % |
| M3L Lehner OC=RA+2RD within 1 km | 67 % | 0 % | 0 % | 0 % | 33 % | 0 % | 142 m | 0 % |
| M3L Lehner OC=RA+2RD within 2.5 km | 78 % | 0 % | 0 % | 0 % | 22 % | 0 % | 169 m | 8 % |
| M4 today + 100× guard within 1 km | 37 % | 48 % | 3 % | 0 % | 38 % | 12 % | 137 m | 0 % |
| M5 water-mask snap 500 m | 38 % | 47 % | 3 % | 0 % | 0 % | 12 % | 138 m | 0 % |

M4's guard: flags 23 of today's 31 short or gully snaps (74 %), and 0 of its 22 right ones (false alarms 0 %).

### main (40 reaches, Strahler ≥ 7 / ≥ 20 000 km²)

Water Body Mask pixels within 1.2 km: 25 of 40; nearest median 48 m.

| Method | ok | gully (< 0.1×) | short | jump (> 2×) | none / flagged | inconclusive | median move | ok but > 1 km off the reach |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M0 max-acc 150 m (today) | 48 % | 53 % | 0 % | 0 % | 0 % | 0 % | 137 m | 0 % |
| M1 max-acc 300 m | 90 % | 10 % | 0 % | 0 % | 0 % | 0 % | 288 m | 0 % |
| M1 max-acc 500 m | 98 % | 3 % | 0 % | 0 % | 0 % | 0 % | 482 m | 0 % |
| M2 Jenson nearest ≥1 km² within 500 m | 80 % | 20 % | 0 % | 0 % | 0 % | 0 % | 126 m | 0 % |
| M2 Jenson nearest ≥10 km² within 500 m | 88 % | 10 % | 0 % | 0 % | 3 % | 0 % | 126 m | 0 % |
| M3 Lehner area match ≤50% within 1 km | 0 % | 0 % | 0 % | 0 % | 100 % | 0 % | – | 0 % |
| M3 Lehner area match ≤50% within 2.5 km | 0 % | 0 % | 0 % | 0 % | 100 % | 0 % | – | 0 % |
| M3L Lehner OC=RA+2RD within 1 km | 0 % | 0 % | 0 % | 0 % | 100 % | 0 % | – | 0 % |
| M3L Lehner OC=RA+2RD within 2.5 km | 0 % | 0 % | 0 % | 0 % | 100 % | 0 % | – | 0 % |
| M4 today + 100× guard within 1 km | 48 % | 53 % | 0 % | 0 % | 48 % | 0 % | 137 m | 0 % |
| M5 water-mask snap 500 m | 80 % | 20 % | 0 % | 0 % | 0 % | 0 % | 468 m | 0 % |

M4's guard: flags 19 of today's 21 short or gully snaps (90 %), and 0 of its 19 right ones (false alarms 0 %).

