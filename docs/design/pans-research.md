# Research: pans and non-contributing area in a delineated catchment

Research for the hydrologist's review, finding 8 (`reviews/persona-hydrologist.md`):
the delineation fills every closed depression in the DEM and routes it to
the outlet, so in the interior's pan veld it proposes a gross catchment and
says nothing about the part that drains into pans. This page records what
South African practice does with that area, how other tools handle it, how
real pans can be told from DEM noise in GLO-30, and the decisions the build
took from that (`backend/src/delineation/pans.ts`;
[delineation.md § Pans](./delineation.md#pans)). Read on 2026-10-03.

## South African practice

- **WR2012 maps "endoreic areas" and treats them as not contributing.** The
  WR2012 User's Guide (Bailey & Pitman 2016, WRC TT 684/16, § 20) says its
  GIS base map shows "both local and global endoreic areas": *local*
  endoreic areas are "catchments with small streams which normally end in
  pans and do therefore not contribute to runoff"; *global* ones "have
  larger river systems but their runoff still does not contribute to
  runoff, e.g. the Molopo area". The layer (`Endoreic Areas`, polygon,
  `Erc_id`) was generated for WR90 in 1995 and carried forward unchanged
  (Table 20.1). The Executive Summary (TT 683/16) lists the same base-map
  layer.
- **Quaternary areas are gross; modelled units can be net.** The same
  guide's Table 16.5 compares the WR2005 management units of the upper
  Olifants (B11, B12: Highveld pans) with the WR90 quaternary areas, and
  says "the difference between the catchment areas for management units
  and the WR90 study is due to endoreic areas (areas not contributing to
  runoff)": 4 489 km² against 4 714 km² for B11 (5 %), up to 21 % for
  B11F. So practice keeps the gross quaternary area for reference and
  calibrates the rainfall–runoff model on the area that contributes. The
  reviewer's expectation (tens of percent in C, D and the Molopo, and
  calibrating on the effective area) matches this.
- **The national mean annual runoff** is 49 251 million m³ a year (WR2012
  Executive Summary, § 4), over South Africa, Lesotho and Eswatini
  (1 268 756 km²): about **39 mm** of runoff a year on average. The pan
  veld of the Free State, North West and Northern Cape lies in the drier
  half of the country, so its mean runoff is well below that.
- **Pans** are, in the wetland literature, endorheic depressions formed
  largely by wind erosion, generally shallow and without integrated
  drainage (DWS, *Preliminary Reserve Study in the Lower Vaal WMA: Wetland
  Reserve Report*). The reviewer counted 4 810 filled depressions in one
  2 048-cell window around Bultfontein, 65 of them at least 0.5 km².

## What other tools and agencies do

- **TauDEM** (Tarboton, `PitRemove`): fills every pit by default, "generally
  taken to be artifacts", but takes an optional **depression mask**
  (`-depmask`) of real depressions it must not fill, or an internal
  no-data cell at a depression's low point to keep it as a sink. The
  user decides which pits are real; the tool doesn't.
- **ArcHydro** `Fill Sinks`: the same idea, with **deranged polygons**
  (areas that drain inward) that are not filled.
- **Lindsay & Creed (2005, 2006)**: depressions in a DEM are a mix of
  artifacts and real features; of five ways to tell them apart (ground
  inspection, the source data, classification, knowledge-based rules,
  modelling) the modelling approach did best: perturb the DEM by its
  error many times (Monte Carlo), fill each, and keep a depression that
  appears in a high share of the runs.
- **Wu & Lane (2017, HESS 21:3579)**: wetland depressions are real
  landscape features with nested fill–spill–merge behaviour; they
  delineate each depression's catchment (contour tree) rather than fill it
  away, and filter depressions by minimum size and depth.
- **The Prairie Farm Rehabilitation Administration (now AAFC)** publishes
  both a **gross drainage area** ("might be expected to entirely contribute
  runoff ... under extremely wet conditions") and an **effective drainage
  area** ("might be expected to entirely contribute runoff to the main
  stream during a flood with a return period of two years", excluding the
  marsh, slough and other natural storage that would keep runoff from the
  stream "in a year of average runoff"; Stichling & Blackwell 1957, Godwin
  & Martin 1975). That is the closest published definition of what the
  hydrologist asked for, and it is defined by **storage against runoff**,
  not by depth alone.

## Telling a pan from DEM noise in GLO-30

- **GLO-30's errors.** Global validation against ICESat: RMSE 1.68 m,
  absolute LE90 2.17 m (the Copernicus DEM validation report, as cited by
  the studies below). Studies in southern Africa: RMSE 2.34 m over Cape
  Town's mixed terrain, 1.1 m in north-west Namibia (both the best of the
  global DEMs compared). GLO-30 is a surface model (trees, buildings and
  embankments are in it) and its water bodies are flattened.
- **Noise depressions** from random height error are a few cells across and
  about the error deep; averaged over 100 cells the random part falls by
  ten. A 1 m deficit spread over 0.1 km² (about 90 cells) is therefore a
  feature, not noise. But GLO-30 also has **coherent** false depressions:
  the pond behind a road or rail embankment whose culvert the DEM doesn't
  see, and a river dam drawn down below its spillway, whose basin is a
  closed depression in the DEM. Depth and area alone don't reject those.
- **Storage against runoff rejects them**, as the PFRA's definition does: a
  dam on a river, or an embankment pond, holds a few millimetres of runoff
  over its own (large) catchment and fills in any ordinary year; a pan
  holds hundreds to thousands of millimetres over its (small) closed
  catchment and does not. In delineations on the real DEM around
  Bultfontein (2026-10-03) the pans that passed held 109 mm to about
  2 700 mm over their catchments, and one 238 km² catchment had 215 km²
  draining into its pans; the synthetic fixture's dam, 5 m
  below its wall, holds 14 mm over its 292 km².

## Decisions

1. **Report, don't remove.** The catchment proposed stays the gross one,
   routed through the filled pans as before. WR2012 keeps gross quaternary
   areas and subtracts endoreic areas for modelling; the PFRA publishes
   both. Changing the routed polygon would hide the gross area the
   quaternary tables quote, and a false pan (a drawn-down dam) would then
   silently remove a real catchment. So the proposal carries a separate
   **non-contributing (pans)** figure, its method, the largest pans with
   their position, depth, floor, catchment and storage, and the **effective
   area** (gross less non-contributing); the hydrologist chooses. Start and
   Divide carry it per piece, per unit's whole catchment and for the
   catchment, with a warning sentence; a saved click piece says it in its
   description.
2. **A pan is a closed depression of the filled DEM that is**
   - at least **1 m** deep below its spill (about GLO-30's RMSE over flat
     land; shallower than that the depth is within the DEM's error);
   - at least **0.1 km²** in floor (about 90 cells, past which a 1 m
     hollow is no longer random noise; Free State pans that matter to a
     catchment's balance are larger, the reviewer's count was 65 of at
     least 0.5 km² in one window);
   - holding at least **100 mm** of its own catchment's runoff below its
     spill: over twice South Africa's mean annual runoff (about 39 mm), so
     a depression that passes needs several average years of its own
     runoff to fill, and does not contribute in a year of average runoff
     (the PFRA's test). A dam drawn down below its spillway, or an
     embankment pond, fails it.
   These are fixed constants recorded in the method (`pans.ts`), not
   settings: a hydrologist who disagrees with a pan sees it listed and
   can ignore the figure.
3. **A depression at a point is the point's own.** The depression holding
   the outlet (or a unit's point in Start/Divide), or spilling into it
   within the snap radius, is never a pan: a click on a dam wall would
   otherwise report the dam's whole catchment as non-contributing.
4. **Not built**: Monte Carlo depression probability (Lindsay & Creed) is
   tens of fills a click, far past the 20 s budget; WR2012's own endoreic
   polygons (the base-map layer) aren't loaded as reference data (their
   licence for redistribution is unknown, and they're 1995 digitising at
   1:250 000); reading the river network to reject a depression a mapped
   river flows through is left for when false positives are seen
   (docs/followups.md).

## Cost

Measured on this laptop against the real DEM around Bultfontein, the
whole window taken as the catchment (the worst case: in a delineation only
the catchment's cells are visited), 2026-10-03:

| Window | Fill | D8 + accumulation | Pans | Resident |
| --- | --- | --- | --- | --- |
| 2 048 cells (≈ 68 km) | 0.65 s | 0.40 s | 0.31 s | 290 MB |
| 3 072 cells (request cap) | 1.7 s | 0.86 s | 0.79 s | 420 MB |
| 6 144 cells (worker cap) | 13.3 s | 4.5 s | 2.7 s | 1.17 GB peak |

The peaks are this run's whole process; measured again on the merged code (`delineate-10`) the worker's largest window peaks at 0.95–1.08 GB across four clicks, given as about 1.1 GB everywhere else ([delineation.md § Where it runs](./delineation.md#where-it-runs)).

The pans need the elevations before the fill: a Float32 copy, 4 bytes a
cell (38 MB at 3 072, 151 MB at 6 144), and a byte a cell of marks. The
request stays far inside its 20 s budget and the API's 1 024 MB; the
worker inside its 150 s budget and 2 048 MB. Pans are looked for only once
the catchment is found whole, so a window the catchment outgrows costs
nothing extra but the copy.

## Sources

- Bailey, A.K. & Pitman, W.V. (2016). *Water Resources of South Africa 2012
  Study (WR2012): User's Guide*. WRC Report TT 684/16 (§ 16 Table 16.5, § 20
  and Table 20.1). <https://www.wrc.org.za/wp-content/uploads/mdocs/TT%20684-16.pdf>
- Bailey, A.K. & Pitman, W.V. (2016). *WR2012: Executive Summary*. WRC
  Report TT 683/16 (§ 4, naturalised MAR). <https://www.wrc.org.za/wp-content/uploads/mdocs/TT%20683-16.pdf>
- Tarboton, D. TauDEM 5, *Pit Remove* (depression mask).
  <https://hydrology.usu.edu/taudem/taudem5/help53/PitRemove.html>
- Esri Community, *Fill (Spatial Analyst) vs Fill Sinks (Arc Hydro Tools)*
  (deranged polygons). <https://geonet.esri.com/t5/water-resources-questions/fill-spatial-analyst-vs-fill-sinks-arc-hydro-tools/td-p/1341112>
- Lindsay, J.B. & Creed, I.F. (2005). Removal of artifact depressions from
  digital elevation models: towards a minimum impact approach.
  *Hydrological Processes* 19; (2006) Distinguishing actual and artefact
  depressions in digital elevation data. *Computers & Geosciences* 32.
- Wu, Q. & Lane, C.R. (2017). Delineating wetland catchments and modeling
  hydrologic connectivity using lidar data and aerial imagery. *Hydrology
  and Earth System Sciences* 21, 3579–3595.
  <https://hess.copernicus.org/articles/21/3579/2017/>
- AAFC / PFRA, *Gross and effective drainage areas for hydrometric gauging
  stations* (definitions after Stichling & Blackwell 1957 and Godwin &
  Martin 1975). <https://gisappl.saskatchewan.ca/metadata/AAFCBasins.htm>
- DWS, *Preliminary Reserve Study in the Lower Vaal WMA: Wetland Reserve
  Report* (pans as endorheic wetlands).
  <https://www.dws.gov.za/wem/documents/Preliminary%20Reserve%20Study%20in%20the%20Lower%20Vaal%20WMA/Wetland%20Reserve%20Report.pdf>
- Copernicus DEM accuracy: the global ICESat validation figures as cited in
  *Assessment of the global Copernicus, NASADEM, ASTER and AW3D digital
  elevation models in Central and Southern Africa* (University of
  Pretoria). <https://repository.up.ac.za/handle/2263/98677>; Cape Town:
  CPUT <https://digitalknowledge.cput.ac.za/handle/11189/10110>.
