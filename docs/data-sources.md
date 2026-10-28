# Data sources: the source register

Every upstream the app takes data from, or plans to, with its host, licence
and attribution, contact, access pattern, the limits we keep to, the
fallback and the owner (issue #604). The map's datasets keep their full
licence reading in [maps.md § Sources](./maps.md#sources); the rain and flow
feeds' mechanics are in [architecture.md § Data feeds](./architecture.md#data-feeds).
What a user sees as credits is the Data sources and credits page
(`/data-sources`), which this register doesn't replace.

## The rule

> **The app never fetches from someone else's server because a feed or a
> user asked.** Each upstream source has **one scheduled ingest job of ours**
> that fetches only what our projects need, politely, into **our own copy**
> (S3 in af-south-1, plus the existing tables), recording source, date and
> file version. Everything in the app (feeds, the cell cache, runs, the Map)
> reads only our copy.

Every source gets:

1. **An entry in this register.**
2. **A copy we control**, with a manifest recording the upstream file's URL,
   ETag/Last-Modified, our hash of the values we kept, and a revision number.
3. **A manual path** (upload or operator import) that writes the same copy,
   used when the job can't get through.
4. **Freshness alarms**: a lag metric per source, with an alarm that also
   fires if the job stops running (`TreatMissingData=breaching`).
5. **A polite client** (the checklist below).

Today the three live feeds (CHIRPS, CHIRPS-GEFS, DWS) still fetch per feed
from the fetcher Lambda. They break the rule, and Rounds 1–3 of #604 move
them onto the copy. Until then their rows say what the code does now and
what it will do.

### The polite-client checklist

Every job that fetches from an upstream:

- [ ] sends one descriptive User-Agent with a contact address;
- [ ] makes conditional GETs (`If-None-Match` / `If-Modified-Since`) and
      skips on 304;
- [ ] fetches whole files or a few large ranges, never thousands of small
      ones;
- [ ] has at most 1–2 requests in flight and makes about 1 request a second;
- [ ] honours `Retry-After`;
- [ ] on a **403, stops the run and alerts**, and never retries.

## How to read and keep the register

- **Status:** `live` (fetched by the app today), `reference load` (the
  operator downloads it and loads it, `load-reference.yml` or
  `tiles-upload.ts`; never fetched by the app), `blocked` (built against a
  synthetic fixture, the licence not yet cleared for production), or
  `planned R<n>` (the #604 round that adds it). Candidates for Round 6 and
  later, and the sources we rejected, are listed after the register.
- **Owner:** the operator owns every source (the decisions, the letters to
  publishers, the licence record); the code column names where its fetch or
  load lives.
- **Adding a source:** add its row to the summary table and its section
  below **before** any code fetches it. `scripts/guards/data_sources.mjs`
  (run by `pnpm test:guards` and CI) fails when a host in `FEED_HOSTS`
  (`backend/src/feeds/http.ts`) or a value `data_feed.source` may take
  (`FEED_SOURCES` and the table's CHECK) has no row here, with the value in
  backticks in the Hosts or Feed source column.
- **Licences** are recorded as read on the publisher's own page, with the
  date. Decision D-B (#326) applies: commercial use allowed and attribution
  fine; non-commercial or share-alike on our output rejected.

## Register

| Id | Source | Status | Hosts | Feed source | Code |
| --- | --- | --- | --- | --- | --- |
| [chirps](#chirps) | CHIRPS v3 daily rainfall (`rnl`, `sat` final and preliminary) | live (feeds paused since 2026-10-25, CHC's 403s); the copy in R1–R3 | `data.chc.ucsb.edu` | `chirps` | `backend/src/feeds/sources/chirps.ts`; R2 `ingest/chirps_final.py`, `backend/src/ingest/daily.ts` |
| [chirps-gefs](#chirps-gefs) | CHIRPS-GEFS v3 16-day forecast | live; the copy built (R3-A), read with `CHIRPS_SOURCE=mirror` | `data.chc.ucsb.edu` | `chirps_gefs` | `backend/src/ingest/gefs.ts` (the copy), `backend/src/feeds/fromMirrorGefs.ts` (feeds read it); `backend/src/feeds/sources/chirps.ts` until the cutover |
| [dws-flow](#dws-flow) | DWS verified daily flow | live (`DWS_SOURCE=live`); the store, its weekly pass and the reply's import built in R3-B, off in production until the stations' records are loaded (`load-reference.yml` kind `dws`) | `www.dws.gov.za` | `dws` | `backend/src/feeds/sources/dws.ts`, `backend/src/ingest/dws.ts`, `backend/scripts/import-dws.ts` |
| [deafrica-waterbodies-series](#deafrica-waterbodies-series) | DE Africa Waterbodies: v0.0.2 per-waterbody wet-area series and v0.0.3 polygons (built R5-A) | built; off in production until `dam_observations_enabled`; the public series frozen upstream since 2024-02 | `deafrica-services.s3.af-south-1.amazonaws.com` | – | `backend/src/dams/observed/` (`waterbodies.ts`, `match.ts`, `tick.ts`), `backend/scripts/import-waterbodies.ts` |
| [deafrica-wofs-scenes](#deafrica-wofs-scenes) | DE Africa WOfS (`wofs_ls`, per Landsat scene) and its STAC search, summed inside our own dam outlines (built R5-C) | built; runs in the fetcher's `dams-weekly` mode, off in production until `dam_observations_enabled` | `explorer.digitalearth.africa`, `deafrica-services.s3.af-south-1.amazonaws.com` | – | `backend/src/dams/observed/wofs/` (`pass.ts`, `stac.ts`, `cog.ts`, `sum.ts`, `utm.ts`) |
| [dynamical](#dynamical) | dynamical.org's copy of CHIRPS v3 | planned R3-E (verification only) | `s3://dynamical-ucsb-chc-chirps` (us-west-2) | – | R3 `ingest/verify_copy.py` |
| [dpet](#dpet) | dPET daily potential evapotranspiration | reference load | `data.bris.ac.uk` | – | `bin/evaporation-fetch.sh`, `pnpm import:evaporation` |
| [worldcover](#worldcover) | ESA WorldCover 10 m 2021 v200 (cropland) | reference load | `esa-worldcover.org` (the operator's download) | – | `pnpm import:land-cover` |
| [hydrorivers](#hydrorivers) | HydroRIVERS v1.0 | reference load | `data.hydrosheds.org` | – | `bin/tiles-dev.sh` (`dev:tiles:rivers`), `pnpm import:rivers` |
| [geonames](#geonames) | GeoNames gazetteer (ZA and neighbours) | reference load | `download.geonames.org` | – | `pnpm import:gazetteer` |
| [jrc-gsw](#jrc-gsw) | JRC Global Surface Water v1.5 occurrence | reference load (tiles) | `s3.waw4-1.cloudferro.com` | – | `bin/tiles-dev.sh` (`dev:tiles:water`), `tiles-upload.ts` |
| [dem](#dem) | Copernicus GLO-30 DEM, Mapterhorn's Terrarium tiles | reference load (tiles) | `download.mapterhorn.com` | – | `bin/tiles-dev.sh` (`dev:tiles:terrain`), `tiles-upload.ts` |
| [basemap](#basemap) | Protomaps basemap (OpenStreetMap) and its label fonts | reference load (tiles) | `build.protomaps.com`, `codeload.github.com` | – | `bin/tiles-dev.sh` (`dev:tiles:fetch`, `dev:tiles:fonts`), `tiles-upload.ts` |
| [waas-map](#waas-map) | WAAS Southwestern Cape MAP grid | reference load | none (a copy from the client) | – | `pnpm import:map-grid` |
| [grdc-caravan](#grdc-caravan) | GRDC-Caravan v0.6 daily streamflow and basin polygons (the GR4J donors, issue #622) | reference load (the donor fit is offline, `pnpm fit-donors`; only the fitted parameters are loaded) | `zenodo.org` | – | `backend/scripts/fit-donors.ts`, `pnpm import:gr4j-donors` (kind `gr4j-donors`) |
| [hydroatlas](#hydroatlas) | HydroATLAS v1.0 basin attributes (BasinATLAS; the donors' copy comes inside GRDC-Caravan) | reference load (the donors' attributes; a target's, from BasinATLAS, with #622 step 5) | `zenodo.org` (inside GRDC-Caravan); `figshare.com` (BasinATLAS) | – | `backend/scripts/fit-donors.ts` |
| [soilgrids](#soilgrids) | SoilGrids 2.0 water retention, `wv0033` and `wv1500` at six depths to 200 cm (the soil water capacity grid) | reference load | `storage.googleapis.com` (bucket `isric-share-soilgrids`) | – | `ingest/soils.py`, `pnpm import:soils` (kind `soils`) |
| [isdasoil](#isdasoil) | iSDAsoil v1 depth to bedrock (the soil grid's root depth) | reference load | `s3://isdasoil` (us-west-2) | – | `ingest/soils.py`, `pnpm import:soils` (kind `soils`) |
| [quaternaries](#quaternaries) | Quaternary outlines and WR2012 values | blocked | `www.dws.gov.za`, WRC (the operator's download) | – | `pnpm import:quaternaries` |
| [dam-register](#dam-register) | DWS List of Registered Dams and its overlay | blocked | `www.dws.gov.za` | – | `pnpm import:dam-register` |
| [gauge-stations](#gauge-stations) | DWS hydrological station catalogue | blocked | `www.dws.gov.za` | – | `pnpm import:gauge-stations` |
| [era5-land](#era5-land) | ERA5-Land daily precipitation | built R4-A; off until `era5l_enabled` (the operator's CDS key first) | `cds.climate.copernicus.eu` (backfill too) | – | `ingest/era5land.py`, `infra/era5land.tf` |
| [ecmwf-ens](#ecmwf-ens) | ECMWF open data ENS 15-day precipitation (0.1°) | built (R4-C); the copy's job off in production until `ecmwf_enabled` | `ecmwf-forecasts.s3.eu-central-1.amazonaws.com` | `ecmwf_ens` | `ingest/ecmwf.py` (the copy), `ingest/ecmwf_qm_fit.py` (the fit), `backend/src/feeds/fromMirrorEcmwf.ts` (feeds read it) |
| [imerg](#imerg) | IMERG Late V07 daily (GSMaP Gauge-NRT second) | the copy built (R4-D), off until `imerg_enabled` (needs the operator's Earthdata token) | `cmr.earthdata.nasa.gov`, `opendap.earthdata.nasa.gov` | – | `ingest/imerg.py`, `infra/imerg.tf` |
| [sanlc](#sanlc) | SANLC orchard and vine classes | built R5-D; blocked in production until its terms are recorded (synthetic grid in dev, CI and e2e) | `egis.environment.gov.za` | `crop_type_dataset` | `pnpm import:crop-types` |
| [agera5](#agera5) | AgERA5 v2.0 daily FAO-56 reference ET | built R5-E; the copy's job off in production until `agera5_enabled` (the CDS key is ERA5-Land's) | `cds.climate.copernicus.eu` | `agera5_et0` | `ingest/agera5.py` (the copy), `backend/src/feeds/fromMirrorEt0.ts` (feeds read it), `infra/agera5.tf` |
| [nasa-power](#nasa-power) | NASA POWER daily weather, our FAO-56 ET₀ from it (AgERA5's fallback) | built R5-E; off until `power_et0_enabled` | `power.larc.nasa.gov` | – (read by `agera5_et0` feeds) | `ingest/nasapower.py`, `ingest/fao56.py`, `infra/agera5.tf` |
| [climate-indices](#climate-indices) | NOAA CPC's ONI (ENSO) and AAO (the SAM's proxy), monthly | built (#620); the fetcher's indices pass off in production until `climate_indices_enabled` | `www.cpc.ncep.noaa.gov` | – | `backend/src/feeds/sources/cpc.ts`, `backend/src/ingest/indices.ts`, `infra/climate_indices.tf` |

## Live feeds

Common to all three today (`backend/src/feeds/http.ts`, the fetcher Lambda
in `infra/feeds.tf`):

- **After the cutover** (issue #604 R3-C; `chirps_source = "mirror"` and
  `dws_source = "store"`, [deployment.md § The
  cutover](./deployment.md#the-cutover)) no feed and no user asks an
  upstream: feeds read our copy and store in the worker's job, and the only
  requests to `data.chc.ucsb.edu` and `www.dws.gov.za` are the scheduled
  passes below (the finals job, the daily preliminary and GEFS passes, the
  weekly DWS pass), each paced and stopped by a 403. Terraform removes the
  per-feed queues then, and on Lambda only the fetcher may make a live
  request at all (`assertLiveFeedRequestsAllowed`): the API and the worker
  are refused whatever their configuration. Until then, the per-feed
  pattern below stays for each source whose flag is on its old value.

- **What a fetch may ask:** only `FEED_HOSTS`, over HTTPS on 443, with
  manual redirects (at most 3, each checked against the list), a 20 s
  timeout and a 4 MB cap per response.
- **Pacing:** the fetcher's reserved concurrency (`fetcher_reserved_concurrency`,
  default 2) caps requests in flight. A 429 or 503 pauses the host by its
  `Retry-After` (at most 15 min, 60 s when it gives none); a 403 pauses it
  for an hour in that process, and the scheduler then backs the feed off
  2 h × 2ⁿ (`242_feed_refused_backoff.sql`).
- **User-Agent:** `water-management-feeds/1 (+https://github.com/Absence0760/project-water-management)`,
  which names the project but **no contact address**. R1-B's polite client
  (`ingest/polite.py`, `INGEST_CONTACT`) adds one.
- **Offline:** `FEED_SOURCE=fixtures` (the default) serves synthetic files,
  so dev, CI and e2e never reach these hosts.

### chirps

- **Source:** CHIRPS v3 daily rainfall, 0.05° grid, products `rnl` (final
  only, from 1981) and `sat` (final from 1998, preliminary two days after
  each pentad). Climate Hazards Center, UC Santa Barbara.
- **Host:** `data.chc.ucsb.edu` (nginx; sends `ETag`, `Last-Modified`,
  `Accept-Ranges: bytes`).
- **Licence:** public domain, registered with Creative Commons and licensed
  CC BY 4.0 ([chc.ucsb.edu/data/chirps3](https://www.chc.ucsb.edu/data/chirps3),
  read 2026-10-01). Commercial use allowed.
- **Attribution:** "Climate Hazards Center Infrared Precipitation with
  Stations version 3 (CHIRPS3) Data Repository: https://doi.org/10.15780/G2JQ0P
  (2025). Data was accessed on [date]." Or Funk, C. et al., *Sci Data* 13,
  718 (2026), doi:10.1038/s41597-026-07096-4. Series are labelled
  `CHIRPS sat` / `CHIRPS rnl` v3.0.
- **Contact:** chc-help@geog.ucsb.edu. Emailed 2026-10-25 about the 403s and
  our planned access pattern; no reply yet (#571).
- **Access pattern today:** each feed range-reads individual daily GeoTIFFs
  (`daily/final/{rnl,sat}/`, `daily/prelim/sat/`) for its cells, about 5
  requests a file, backfilling from 1981, from the fetcher Lambda's rotating
  addresses. That pattern got the fetcher banned (HTTP 403) on 2026-10-25,
  and the CHIRPS feeds are paused.
- **Access pattern after the cutover (`chirps_source = "mirror"`; built R1–R3):** one ingest job for the whole region
  (D1: 10–41°E, 35.5–8°S), into Zarr `rnl`, `sat` and `prelim` with a
  `manifest.json` each:
  - finals: one `byMonth` NetCDF listing per product around the 20th–25th,
    then the new or changed month's file, whole (about 330 MiB);
  - backfill: about 550 `byMonth` files for `rnl` (316 for `sat`), one a
    minute;
  - preliminary `sat`: only new files, as the strip-offset table plus one
    range over the region's rows, about 3 requests a file.

  Feeds read the copy in the worker's job; none asks CHC.
- **Limits we keep to:** one request in flight and about 1 a second **in
  total across our Lambdas**, as CHC asked on 2026-10-27 (dynamical.org
  settled on the same): each client paces itself, and the fetcher and the
  mirror-ingest job share one request slot, a lease in the mirror bucket,
  so only one of them asks CHC at a time
  ([architecture.md § Data feeds](./architecture.md#data-feeds), Throttling); about 50–60
  requests a day for prelim and GEFS together, under 10 a month for finals,
  however many feeds or projects there are; a 403 stops the run and alerts.
  CHC publishes no rate limit.
- **Rewrites:** CHC rewrites files in place with no version number and no
  checksums. The copy keeps (mtime, size, ETag) per file, re-downloads on a
  change, and bumps the revision only when the hash of the region's values
  changes (D8).
- **Fallback:** for `rnl` finals, dynamical.org's copy as an emergency
  cross-check ([dynamical](#dynamical)), then waiting a month; for `sat`
  finals, waiting; for preliminary days, IMERG Late (R4-D). The manual path
  is the series upload (CSV or paste) on the unit.
- **Owner:** the operator; code `backend/src/feeds/sources/chirps.ts`, then
  R1-B/R2-A `ingest/`, R2-B `backend/src/ingest/daily.ts`.

### chirps-gefs

- **Source:** CHIRPS-GEFS v3, the 00 UTC GEFSv12 ensemble mean
  quantile-matched to CHIRPS at 0.05°, 16 daily files per issue, around
  08:30 UTC. DOI 10.15780/G2PH2M.
- **Host:** `data.chc.ucsb.edu`, the same server as CHIRPS, so the same
  exposure.
- **Licence and attribution:** as [chirps](#chirps); cite Harrison et al.
  (2022) for the method.
- **Contact:** chc-help@geog.ucsb.edu.
- **Access pattern:** the copy (R3-A). The fetcher's GEFS pass reads one
  issue a day for the region (today's, else yesterday's, complete issues
  only: the 16th day's file first), the header and strip-offset table plus
  one range over the region's rows per file, into Zarr `gefs/<issue>`
  listed in `gefs/index.json`; the newest 7 issues kept. Feeds read the copy
  (`CHIRPS_SOURCE=mirror`), never CHC. Until the cutover production keeps
  the old pattern: each feed reads today's issue (else yesterday's) for its
  cells.
- **Limits we keep to:** 16 files a day, about 48 requests, at about 1
  request a second; a run that finds the day's issue held sends none; a 403
  stops the run and alerts.
- **Fallback:** ECMWF ENS (R4-C), then a day-old issue, labelled as such.
- **Owner:** the operator; code `backend/src/ingest/gefs.ts` and
  `backend/src/feeds/fromMirrorGefs.ts` (R3-A), `backend/src/feeds/sources/chirps.ts`
  for the per-feed path until the cutover.

### dws-flow

- **Source:** DWS (Department of Water and Sanitation) verified daily mean
  flow for a river gauge, `Hydrology/Verified/HyData.aspx?Station=<code>100.00&DataType=Daily&…`.
- **Host:** `www.dws.gov.za`. It refuses our dev network and other
  non-South-African addresses with HTTP 403; from af-south-1 it answers
  (first production fetches 2026-10-26, which got its ScriptServer error
  page for a 10-year span, followups.md).
- **Licence:** **permission obtained** for storing DWS verified daily flow
  and showing results derived from it in the tool, through the client's
  hydrologist (recorded by the operator 2026-10-28, #618 step 6a; the
  written permission is kept with the client's records, not in this public
  repo). It covers the verified daily flow only: the station catalogue, the
  register of dams and the quaternary outlines below have their own terms.
  DWS publishes no API and no terms for these pages; its NIWIS wording
  elsewhere says data "may not be sold to third parties" and is "restricted
  to use for academic, research or personal purposes" ([maps.md §
  Sources](./maps.md#sources); followups.md, Terms of use), so the tool
  never sells or redistributes the raw values.
- **Attribution:** "Department of Water and Sanitation" as the copyright
  owner.
- **Contact:** DWS National Hydrological Services, GeoRequests@dws.gov.za
  (Hydstra data), for full records on request.
- **Access pattern with `DWS_SOURCE=live` (production today):** each DWS feed asks for a 2-year window
  (`DWS_WINDOW_DAYS`, 365-day re-read) per station; the site allows 20 years
  a request.
- **Access pattern built (R3-B, D14):** the written data request is the
  primary route, loaded by the operator (`pnpm import:dws`) into
  `gauge_record` (247) as source `dws-request`; a **weekly** pass (the
  fetcher's `dws-weekly` mode, run daily, each station re-read once its last
  good fetch is 6 days old) asks only for the stations enabled DWS feeds
  name, the newest 2-year window each, and the worker loads it as `dws-web`.
  With `DWS_SOURCE=store` a feed reads the store and never asks DWS
  ([deployment.md § DWS gauge records](./deployment.md#dws-gauge-records)).
  Production stays on `live` (and the pass off) until the records are loaded; after
  the cutover (`dws_source = "store"`) the weekly pass and the operator's
  loads of DWS's replies are the only access, and no feed asks DWS.
- **Limits we keep to:** 1 request a second, one User-Agent; a 403,
  throttling (429/503) or the ScriptServer page stops the pass, marks the
  source stale (`dws/status.json`) and alerts (`MirrorLagDays{Product=dws}`),
  never retried.
- **Fallback:** the manual DWS import, already built
  (`frontend/src/lib/series/dws.ts`, sharing the engine's parser,
  `@water-management/engine/dws`).
- **Owner:** the operator; code `backend/src/feeds/sources/dws.ts`,
  `backend/src/ingest/dws.ts`, `backend/src/feeds/fromGaugeRecord.ts`,
  `backend/scripts/import-dws.ts`.

## Dam observations

What satellites saw of each traced dam, into `dam_observation` (migration
261; [architecture.md § Dam observations](./architecture.md#dam-observations)).
The same out-of-VPC handover as the weekly DWS pass: the worker writes the
wanted list to the mirror bucket, the fetcher's hourly `dams-weekly` run
reads the upstream and writes files back, and the worker loads them. Hourly
for the WOfS backfill's pace only: each key keeps its own cadence below.

### deafrica-waterbodies-series

- **Source:** Digital Earth Africa Waterbodies. The per-waterbody surface
  area series, `waterbodies/v0.0.2/surface_area_change/<uid[0..4]>/<uid>.csv`
  (header `date,px_total,px_wet,area_wet_m2,px_dry,area_dry_m2,px_invalid,area_invalid_m2,pc_wet,pc_dry,pc_invalid`),
  for each dam matched to a waterbody; and the waterbody polygons,
  `waterbodies/v0.0.3/historical_extent/waterbodies.gpkg` (about 900 MB, the
  continent), which the operator clips and loads as a reference dataset
  ([maps.md § Waterbodies](./maps.md#waterbodies)).
- **Host:** `deafrica-services.s3.af-south-1.amazonaws.com` (the
  `deafrica-services` bucket over HTTPS, anonymous; the same region as the
  app). `FEED_HOSTS` holds it for the fetcher's live client.
- **Licence:** CC BY 4.0 (Digital Earth Africa, read by the lead
  2026-10-27; [maps.md § Sources](./maps.md#sources)).
- **Attribution:** "Digital Earth Africa, CC BY 4.0"
  (`dams/observed/upstream.ts` `DEAFRICA_ATTRIBUTION`) wherever an observed
  value shows (R5-B's chart and farmer view), and on `/data-sources`.
- **Contact:** Digital Earth Africa's help desk and community forum
  (digitalearthafrica.org; docs.digitalearthafrica.org).
- **Access pattern:** the fetcher's `dams-weekly` mode (run hourly at
  :20, `infra/dam_observations.tf`) reads `dams/wanted.json` and asks
  for each matched dam's uid whose last good fetch is 7 days old or more
  (and that wasn't asked within the last day, so a failing uid is asked
  once a day, not hourly), oldest first, with `If-None-Match` on the ETag the last fetch kept: an
  unchanged file costs a 304 and no body. It writes `dams/waterbodies/<uid>.json`
  and `dams/waterbodies-status.json`; the worker loads them into
  `dam_observation` for every dam matched to that uid
  (`backend/src/dams/observed/`). Only uids our dams overlap are ever asked,
  and the polygons are a reference load, never fetched by the app.
- **Limits we keep to:** one request a second; at most 30 % of the run's
  time (the rest is WOfS's); feeds/http.ts's User-Agent, host allowlist,
  20 s timeout and 4 MB cap; a 429/503 pauses the host for its
  `Retry-After` and stops the run, as does a 403, never retried: the status
  says `stopped` and why, the invocation fails (the fetcher's Errors alarm),
  and the heartbeat still goes out. Then the source is **paused** for 24
  hours from that run (or the `Retry-After`, if longer): the hourly runs ask
  it nothing and publish no heartbeat for it, so its heartbeat alarm fires
  ([architecture.md § Dam observations](./architecture.md#dam-observations)). A 404 (a uid with no
  series) or a changed layout is recorded for that uid, which waits a day,
  and the run goes on.
- **Rows kept:** `wet_area_m2` = `area_wet_m2`, `pct_observed` =
  100 − `pc_invalid`; a date with nothing seen clearly (`pc_invalid` 100 or
  an empty `pc_wet`) is dropped, since 0 m² wet on a date nobody saw reads
  as an empty dam ([architecture.md § Dam observations](./architecture.md#dam-observations)).
- **Freshness:** the pass's heartbeat (`DamPassCompleted{Source=waterbodies}`)
  alarms when missing for 18 hours (a refusal's pause included). **No recency alarm, on purpose.**
  Checked 2026-10-27: the public series objects were last written
  2024-02-26 and a sampled series ends 2023-09-17, though the product says
  it updates weekly. A recency alarm would fire from day one; the metric
  (`DamObservationAgeDays{Source=waterbodies}`) is still published, so a
  restart upstream shows. Ask DE Africa whether the public series will be
  updated again (operator step).
- **Fallback:** [deafrica-wofs-scenes](#deafrica-wofs-scenes) (R5-C): WOfS summed inside
  the dam's own outline, current (the newest Western Cape scene 2026-10-20
  when checked), and the only source for a dam Waterbodies merges or misses.
- **Owner:** the operator; code `backend/src/dams/observed/` (`match.ts`,
  `waterbodies.ts`, `tick.ts`, `handover.ts`), `backend/scripts/import-waterbodies.ts`,
  `infra/dam_observations.tf`.

### deafrica-wofs-scenes

- **Source:** Digital Earth Africa Water Observations from Space, Landsat
  collection `wofs_ls` (1-0-0): one item per Landsat 5/7/8/9 path/row scene,
  its `water` asset a cloud-optimised GeoTIFF of WOfS's per-pixel bit flags
  (128 clear water, 0 clear dry, anything else not a clear observation),
  30 m, in UTM. Found through DE Africa's STAC search; summed inside each of
  our traced dam outlines by us, for every dam, matched to a waterbody or
  not. The newest Western Cape scene was 2026-10-20 when checked
  (2026-10-27): current, unlike the Waterbodies series.
- **Hosts:** `explorer.digitalearth.africa` (`/stac/search`; its
  `/stac/collections/wofs_ls` answered 500 that day, the search works) and
  `deafrica-services.s3.af-south-1.amazonaws.com` (the scenes, anonymous
  range reads, same region as the app). Both are in `FEED_HOSTS`; a STAC
  answer may only point at a `wofs_ls/…tif` key in that bucket and at its
  own next page ([security.md § Data feeds](./security.md)).
- **Licence:** CC BY 4.0 (Digital Earth Africa, read by the lead
  2026-10-27).
- **Attribution:** "Digital Earth Africa WOfS, CC BY 4.0" wherever the
  values show: the evidence report's § 7
  ([evidence-pack.md § Observed wet days](./evidence-pack.md#observed-wet-days)),
  R5-B's chart and farmer view, and `/data-sources`.
- **Contact:** Digital Earth Africa's help desk and community forum
  (digitalearthafrica.org; docs.digitalearthafrica.org).
- **Access pattern:** the fetcher's hourly `dams-weekly` run, after the
  Waterbodies pass, with the rest of the run's time
  ([architecture.md § Dam observations](./architecture.md#dam-observations)).
  Each dam's newest scenes are checked at most once a UTC day (`REFRESH_DAYS`;
  a turn that failed waits for the next day too); every other run's time
  goes to the history. For each dam in turn: one STAC search per
  year window over the outline's box (100 items a page), then per scene its
  header (16 KB) and the tiles under the outline, as one range where they
  sit together: about 2–3 requests a scene, a few KB to tens of KB each,
  never a whole scene. It writes `dams/wofs/<featureId>.json` (each row's
  STAC item id, each item's URL and ETag), `dams/wofs-status.json`, and its
  own `dams/wofs-state.json` (how far each dam is scanned, and its
  outline's hash); the worker loads the rows into `dam_observation`
  (source `wofs`). Every dam's newest scenes come first; the history goes
  back to 2013 (the Landsat 8 era, `WOFS_BACKFILL_FROM`) with the time
  left, newest first, and resumes across runs (about seven hours of hourly
  runs per dam); after it, a dam searches only its last 45 days, once a
  day, for scenes published late, and reads only scenes whose STAC item id
  it hasn't read (an item id is one processing of one scene and never
  changes), so a day with nothing new published costs one search.
- **Limits we keep to:** STAC at most one request a second, the bucket at
  most five a second, one request in flight; feeds/http.ts's User-Agent,
  host allowlist, 20 s timeout and 4 MB cap; a 403 or 429/503 from either
  host stops the pass, never retried (the status says `stopped` and why,
  the invocation fails, the heartbeat still goes out), and pauses the WOfS
  pass for 24 hours from that run (or the `Retry-After`, if longer): no
  request and no heartbeat, so its heartbeat alarm fires. A scene
  that can't be read is skipped and counted; a failed search or a timeout
  ends that dam's turn.
- **Freshness:** the pass's heartbeat (`DamPassCompleted{Source=wofs}`,
  missing for 18 hours) and its recency, the days since the newest observation any dam holds
  (`DamObservationAgeDays{Source=wofs}`), both alarmed
  (`infra/dam_observations.tf`, `treat_missing_data = "breaching"`, off
  until `dam_observations_enabled`).
- **Rows kept:** per dam and date, the wet area (wet pixels × the pixel's
  ground area) and the share of the outline seen clearly; two scenes on one
  date give the one that saw more. No row for a date the dam's outline
  holds no pixel centre or the scene's footprint missed it.
- **Fallback:** none current: Waterbodies' public series are frozen
  ([deafrica-waterbodies-series](#deafrica-waterbodies-series)), and
  Sentinel-1/2 water masks are a Round 6 candidate. The values already
  loaded stay in `dam_observation`.
- **Offline:** `FEED_SOURCE=fixtures` answers STAC and the scenes from
  invented ones (`backend/fixtures/feeds/wofs-sample.json`,
  `wofs/fixtures.ts`), so dev, CI and e2e never reach either host.
- **Owner:** the operator; code `backend/src/dams/observed/wofs/`.
## The copy's recent days

### imerg

- **Source:** NASA GPM IMERG Late Run, daily, version 07
  (`GPM_3IMERGDL`, DOI 10.5067/GPM/IMERGDL/DAY/07), 0.1° grid, about 14 h
  after the day ends. One NetCDF-4 file a day,
  `3B-DAY-L.MS.MRG.3IMERG.YYYYMMDD-S000000-E235959.V07C.nc4`; variable
  `precipitation(time, lon, lat)`, the day's mean rate in mm/day (V06
  called it `precipitationCal`). V07 Final stopped at 2025-09-30 and V08
  is due "fall 2026" ([Earthdata](https://www.earthdata.nasa.gov/data/alerts-outages/transition-gpm-imerg-products-v08));
  Early and Late stay in V07 "hybrid" mode until at least winter 2026. The
  copy records each day's collection version (`V07`, later `V08`) in its
  manifest, because bias correction is fitted per version (D16).
- **Hosts:** `cmr.earthdata.nasa.gov` (the granule search, no sign-in) and
  `opendap.earthdata.nasa.gov` (Hyrax OPeNDAP in AWS us-west-2, behind an
  Earthdata Login bearer token). The whole file is also on
  `data.gesdisc.earthdata.nasa.gov`; we don't fetch it.
- **Licence:** NASA's data use guidance says data from a NASA-led mission is
  CC0 unless marked otherwise
  ([Earthdata](https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance),
  read 2026-10-27); the AWS Open Data registry lists the collection as CC BY
  4.0 ([registry](https://registry.opendata.aws/nasa-gpm3imergdl/), read
  2026-10-27). Commercial use allowed either way. We attribute as CC BY
  asks, which also meets NASA's "NASA should be acknowledged as the
  source" and its request to cite, without implying NASA's endorsement.
- **Attribution:** "Huffman, G.J., E.F. Stocker, D.T. Bolvin, E.J. Nelkin,
  J. Tan (2024), GPM IMERG Late Precipitation L3 1 day 0.1 degree x 0.1
  degree V07, edited by Andrey Savtchenko, Greenbelt, MD, Goddard Earth
  Sciences Data and Information Services Center (GES DISC), accessed
  [date], doi:10.5067/GPM/IMERGDL/DAY/07." (CMR's collection citation,
  release date 2024-06-07.) Series are labelled `IMERG Late` with the
  day's version, and the citation is given once per version the values
  carry; where it shows: as ERA5-Land's, [below](#era5-land-r4-a).
- **Contact:** GES DISC user services (the help link on disc.gsfc.nasa.gov)
  and the Earthdata forum. Needs an Earthdata Login account and a user token
  (operator step, docs/deployment.md § IMERG Late).
- **Access pattern:** the mirror-ingest Lambda, 4 times a day
  (`{"product":"imerg_late","mode":"recent"}`): one CMR search for the
  last 10 days, then for each day not held from the same granule one
  OPeNDAP DAP4 request returning only region D1 (310 × 275 cells, about
  0.2 MB, instead of the 26 MB global file), newest day first, into Zarr
  `imerg_late` (0.1°, daily layout). 30 days kept, then dropped. Which days
  the engine takes from IMERG (only where CHIRPS has no preliminary value)
  is decided later, in the engine, not by the copy.
- **Limits we keep to:** about 1 request a second, at most 11 requests a
  run and usually 1 or 2 (the search, plus the day that landed), about 10
  a day. A 403 or 401 stops the run with no retry, alarms, and writes a
  same-day marker (`ingest-state/imerg_late/refused.json`) so the day's
  later runs ask nothing. GES DISC publishes no rate limit for OPeNDAP.
- **Fallback:** CHIRPS preliminary, then finals, cover every day within a
  week or so; GSMaP Gauge-NRT (commercial use allowed with credit, FTP
  after registration) is the second near-real-time option if IMERG stops.
- **Owner:** the operator; code `ingest/imerg.py`, `infra/imerg.tf`.

### ecmwf-ens

- **Source:** ECMWF open data, the IFS ensemble (ENS) 00 UTC run, total
  precipitation `tp`, at 0.1° (published from 2026-10-20, about two hours
  after the 0.25° files; the 00 UTC run's 0.1° files appeared at 09:40 UTC
  on 2026-10-26), 50 perturbed members, steps 24 to 360 h. AIFS-ENS is not
  used: its open data is 0.25° only.
- **Host:** `ecmwf-forecasts.s3.eu-central-1.amazonaws.com`, the AWS
  mirror of data.ecmwf.int (the bulk path ECMWF documents), anonymous. ECMWF
  keeps only the last ~12 runs, so what we keep, we copy.
- **Licence and attribution:** CC BY 4.0 and the ECMWF Terms of Use, read on
  ECMWF's open data page 2026-10-27: commercial use and redistribution
  allowed with attribution. Credit "ECMWF open data, CC BY 4.0" wherever its
  values show: the feed's line in Data → Data feeds
  (`frontend/src/lib/components/feeds/feeds.ts` calibrationNote), and from
  R4-E a forecast run whose every forecast day an `ecmwf_ens` feed wrote
  records `forecastRainSource: 'ecmwf_ens'` (backend `runs/execute.ts`), so
  its report, summary CSV, daily CSV, workbook and pack credit it: as
  ERA5-Land's, [below](#era5-land-r4-a).
- **Contact:** ECMWF support (Support Portal); no account needed.
- **Access pattern:** the copy only (`ingest/ecmwf.py`, the Python ingest
  Lambda, `infra/ecmwf.tf`): each step's `.index` (JSON lines with each
  field's byte offset and length), then one range request per member for its
  `tp` field, never the 3–4 GB step file. Decoded with eccodes, the region
  cut out on our 0.1° grid, de-accumulated to daily mm, and stored as the
  ensemble mean and p10/p50/p90 in Zarr `ecmwf/<issue>`, listed in
  `ecmwf/index.json`; the newest 7 issues kept whole, older ones archived as
  their mean for the quantile-mapping fit (`ingest/ecmwf_qm_fit.py`, the
  operator's). Feeds (`ecmwf_ens`) read only the copy: there is no per-feed
  path to ECMWF.
- **Limits we keep to:** 1 + 50 requests a step, 765 an issue (~1.1 GB), at
  most one a second, one run at a time (a lease), spread over the runs of
  one morning (every 20 minutes from 10:00 to 13:40 UTC; a run that finds
  the day's issue held asks nothing); a 403 stops the run, never retried,
  and a same-day marker (`ecmwf/refused.json`) stops the day's later runs.
- **Fallback:** CHIRPS-GEFS; then a day-old issue (a feed reads today's,
  else yesterday's).
- **Limitation of the calibration:** the quantile-mapping fit
  (`ingest/ecmwf_qm_fit.py`) pairs the ensemble mean with observed rain per
  0.1° cell, but the feed applies it to a catchment's area-weighted mean
  (`backend/src/feeds/fromMirrorEcmwf.ts`), whose distribution differs:
  averaging over cells gives more small-rain days and fewer extremes, so a
  per-cell mapping can push an area mean's tails too far and leave its
  drizzle under-corrected. The durable fix is to fit on area means for the
  feed's region, tracked in [followups.md § The rain data copy](./followups.md#the-rain-data-copy-issue-604),
  to be done when the first fit is run, once the archive holds a season.
- **Owner:** the operator; code `ingest/ecmwf.py`, `ingest/ecmwf_qm_fit.py`,
  `backend/src/ingest/ecmwf.ts`, `backend/src/feeds/fromMirrorEcmwf.ts`.

## Planned: the copy's cross-check

### dynamical

- **Source:** dynamical.org's Icechunk/Zarr copy of CHIRPS v3 (`rnl` final
  from 1981, `sat` preliminary from 2025), v0.1.0.
- **Host:** `s3://dynamical-ucsb-chc-chirps` (us-west-2, AWS Open Data),
  anonymous.
- **Licence:** CC BY 4.0 as dynamical.org publishes it; attribute CHIRPS as
  in [chirps](#chirps) and dynamical.org.
- **Contact:** dynamical.org's GitHub (`dynamical-org/reformatters`).
- **Access pattern:** read by the verification script only (R3-E), which
  compares the whole region against our copy. Never written to the cell
  cache (D10).
- **Limits we keep to:** AWS Open Data has no stated limit; one verification
  run per backfill.
- **Caveats:** values keep 8 mantissa bits (median 0.067%, max 0.195% off
  CHC on the D1 box, Round 0), CHC's rewrites of older data don't reach it,
  and it has no SLA.
- **Fallback:** none needed (it is itself the fallback, D5).
- **Owner:** the operator; R3-E `ingest/verify_copy.py`.

## Reference datasets

Loaded by the operator, never fetched by the app: a local load reads the
operator's download; a production load goes through `load-reference.yml`
and the migrate Lambda (tables) or `tiles-upload.ts` (tiles). Each dataset
table records its label, source, version and attribution, and
`reference_load` the key and SHA-256 of a production load. The tile
archives are recorded in `reference_load` too (migration 248, kind
`tiles`): our SHA-256, the upstream's URL, version, ETag and Last-Modified,
the licence, and the originals kept in the reference bucket under
`originals/<dataset>/` with their hashes; the operator reads it with the
`reference-provenance` check, and the Map shows the version and dates on
the DEM's and the water occurrence's dataset lines. The per-dataset
refresh runbook is [deployment.md § Reference datasets, Refreshing a
dataset](./deployment.md#refreshing-a-dataset). Download checksums are pinned in
`bin/source-checksums.sha256` ([maps.md § Checksums](./maps.md#checksums)).
The full licence readings are in [maps.md § Sources](./maps.md#sources).
Refresh is yearly at most; the fallback for each is the original file kept
in the reference bucket.

| Id | Licence (read) | Attribution | Contact | Access pattern | Limits we keep to | Fallback | Provenance recorded | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| <a id="dpet"></a>dpet | CC BY 4.0 (data.bris, read 2026-10-02); contains modified Copernicus (ERA5-Land) information | "hPET/dPET © Singer et al. 2021, University of Bristol, CC BY 4.0. Contains modified Copernicus Climate Change Service information (ERA5-Land, CC BY 4.0); neither the European Commission nor ECMWF is responsible for any use of it." | the data.bris dataset page | yearly files, ~2.4 GB each, downloaded whole, reduced, then deleted (`pnpm import:evaporation:fetch`) | one file at a time; SHA-256 recorded on first fetch and checked after | the reduced grid in the reference bucket; the synthetic grid locally | `evaporation_dataset` (source, version); `reference_load` (kind `evaporation`: file key, SHA-256) | operator; `bin/evaporation-fetch.sh`  |
| <a id="worldcover"></a>worldcover | CC BY 4.0 (esa-worldcover.org and Zenodo 10.5281/zenodo.7254221, read 2026-10-01) | "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium"; in reports, Zanaga, D. et al. (2022) | esa-worldcover.org | the operator's tiles, pre-summarised into cells at import | a handful of tiles, once | the summarised grid in the reference bucket | `cropland_dataset`; `reference_load` (kind `land-cover`) | operator; `pnpm import:land-cover`  |
| <a id="hydrorivers"></a>hydrorivers | HydroSHEDS v1 licence: free for commercial use, incorporated into derivative works only (TechDoc v1.0 § 4.1, read 2026-10-01) | Exhibit B's statement, on `/data-sources#hydrorivers`; cite Lehner & Grill (2013) | hydrosheds.org | one zip (`HydroRIVERS_v10_af_shp.zip`), whole | one request; SHA-256 pinned | the zip in the reference bucket | each reach's source; `reference_load` (kind `rivers`) | operator; `bin/tiles-dev.sh`  |
| <a id="geonames"></a>geonames | CC BY 4.0 (the dump's `readme.txt`, read 2026-10-13) | "GeoNames (geonames.org), CC BY 4.0" | geonames.org | seven country dumps (ZA, BW, LS, MZ, NA, SZ, ZW), whole | seven requests a refresh | the dumps in the reference bucket | each place's source; `reference_load` (kind `gazetteer`) | operator; `pnpm import:gazetteer`  |
| <a id="jrc-gsw"></a>jrc-gsw | Copernicus free, full and open; "provided free of charge, without restriction of use" (download page, read 2026-10-02) | "Source: EC JRC/Google"; cite Pekel et al. (2016) | the JRC GSW download page | the six occurrence tiles over `TILES_BBOX`, whole | six requests; SHA-256 pinned | the PMTiles in the tiles bucket | `reference_load` (kind `tiles`, dataset `water`): SHA-256, version, ETag, Last-Modified, licence, the six tiles as originals | operator; `bin/tiles-dev.sh`  |
| <a id="dem"></a>dem | Copernicus WorldDEM-30 licence, commercial use allowed (read 2026-10-01); tiles by Mapterhorn (code BSD-3) | the Art. 6(b) notice and "© Mapterhorn" while the relief is drawn; Art. 6(c) on `/data-sources` | mapterhorn.com | `pmtiles extract` of the region's byte ranges from the planet archive | one extract a refresh; ETag-consistent reads | the PMTiles in the tiles bucket | `reference_load` (kind `tiles`, dataset `terrain`): SHA-256, version, ETag, Last-Modified, licence, the extract as its original | operator; `bin/tiles-dev.sh`  |
| <a id="basemap"></a>basemap | ODbL 1.0 for the OpenStreetMap data (openstreetmap.org/copyright, read 2026-10-01); label fonts SIL OFL 1.1 | "© Protomaps © OpenStreetMap contributors", always on the map; the OFL notice beside the glyphs | protomaps.com; OpenStreetMap Foundation | `pmtiles extract` of one daily build (`TILES_BUILD`) for the region; fonts as one archive of a pinned commit (`FONTS_REF`) | one extract and one archive a refresh | the PMTiles and fonts in the tiles bucket | `reference_load` (kind `tiles`, datasets `basemap` and `fonts`): SHA-256, build date or commit, ETag, licence, the extract and the fonts archive as originals | operator; `bin/tiles-dev.sh`  |
| <a id="waas-map"></a>waas-map | terms not stated; the operator's decision (2026-10-23) to use it, [legal/map-data-licences.md § 3.3b](./legal/map-data-licences.md#33b-the-southwestern-cape-map-surface-waas-the-operators-decision-added-2026-10-23) | "Mean annual rainfall surface for the Southwestern Cape. Prepared for the WAAS project by Beuster Clarke & Associates. March 2007, Version 1.1." | the client | a file from the client; no download | none fetched | the file in the reference bucket | `rain_map_dataset` (recorded source, version, credit); `reference_load` (kind `map-grid`) | operator; `pnpm import:map-grid`  |
| <a id="grdc-caravan"></a>grdc-caravan | CC BY 4.0 (Zenodo record 10.5281/zenodo.15349031, v0.6 of 2025-05-06, and the archive's `licenses/grdc/license_grdc.md`, read 2026-10-28); the per-country terms in `licenses/grdc/LicensesCaravan.xlsx` (read 2026-10-28): South Africa (DWS) and Namibia, the only countries in region D1, "Free to use" ([below](#gr4j-priors-issue-622)) | "Donor flow records: GRDC-Caravan (Färber et al. 2025, Zenodo 10.5281/zenodo.15349031), CC BY 4.0, from data held by the Global Runoff Data Centre (GRDC); South Africa’s and Namibia’s records © their departments of water."; cite Färber et al. (2025) and Kratzert et al. (2023) | the Zenodo record; GRDC (BfG, Koblenz) | one zip (`GRDC_Caravan_extension_csv.zip`, 8.8 GB), whole, by the operator; the donor fit reads it offline | one download a refresh; never fetched by the app | the zip in the reference bucket (`originals/gr4j-donors/`); the synthetic donors locally | `gr4j_donor_dataset` (source, version, method, engine version, the set's SHA-256); `reference_load` (kind `gr4j-donors`) | operator; `backend/scripts/fit-donors.ts` |
| <a id="hydroatlas"></a>hydroatlas | CC BY 4.0 ("The HydroATLAS database is licensed under a Creative Commons Attribution (CC-BY) 4.0 International License", hydrosheds.org/hydroatlas, read 2026-10-28) | "Basin attributes: HydroATLAS v1.0 (BasinATLAS; Linke et al. 2019, Lehner et al. 2022), CC BY 4.0." | hydrosheds.org | the donors': GRDC-Caravan's `attributes_hydroatlas_grdc.csv`, no download of its own; a target's: BasinATLAS v1.0 (figshare 10.6084/m9.figshare.9890531), one download, with #622 step 5 | none fetched by the app | the files in the reference bucket | with the donors (`gr4j_donor`) | operator; `backend/scripts/fit-donors.ts` |
| <a id="soilgrids"></a>soilgrids | CC BY 4.0: the layers' own records on data.isric.org (wv0033 `14e7c761-6f87-4f4c-9035-adb282439a44`, wv1500 `f5a1188a-09f8-4ef6-b841-93f08e3903f4`: "Attribution 4.0 International (CC BY 4.0)") and ISRIC's SoilGrids FAQ ("SoilGrids products are provided under the CC BY 4.0"), read 2026-10-28 | "Soil water retention: SoilGrids 2.0 © ISRIC – World Soil Information, CC BY 4.0."; cite Turek et al. (2023) | soilgrids@isric.org | the twelve mean GeoTIFFs (two properties × six depths, about 2.2 GB each), read by GDAL over HTTP for region D1 only, by the operator | twelve files a refresh; the REST API is not used (paused, and 5 calls a minute) | the resampled grids in the reference bucket; the synthetic grid locally | `soil_dataset` (source, version, method); `reference_load` (kind `soils`) | operator; `ingest/soils.py` |
| <a id="isdasoil"></a>isdasoil | CC BY 4.0 (the AWS Registry of Open Data entry iSDA manages, registry.opendata.aws/isdasoil: "License: CC-BY 4.0", read 2026-10-28) | "Depth to bedrock: iSDAsoil © Innovative Solutions for Decision Agriculture (iSDA), CC BY 4.0."; the registry asks for "iSDAsoil was accessed on DATE from https://registry.opendata.aws/isdasoil" | iSDA (isda-africa.com) | one cloud-optimised GeoTIFF (`soil_data/bedrock_depth/bedrock_depth.tif`, 23.6 GB, EPSG:3857), read by GDAL for region D1 at its overviews | one file a refresh | the resampled grid in the reference bucket | with the soil grid (`soil_dataset`) | operator; `ingest/soils.py` |
| <a id="quaternaries"></a>quaternaries | **blocked:** DWS outlines' commercial terms unconfirmed; WR2012 redistribution terms unpublished | DWS; WR2012 (WRC 2015) | DWS; WRC | the operator's download, loaded into the operator's own database only | – | the synthetic fixture everywhere else | – (never loaded in production) | operator; `pnpm import:quaternaries`  |
| <a id="dam-register"></a>dam-register | **blocked:** no terms on the DSO page; DWS's general terms are non-commercial | "Department of Water and Sanitation" | DWS Dam Safety Office | the operator's XLS and KMZ download | – | the synthetic list | – (never loaded in production) | operator; `pnpm import:dam-register`  |
| <a id="gauge-stations"></a>gauge-stations | **blocked:** unconfirmed (the Verified pages answer 403 outside South Africa) | "Department of Water and Sanitation" | GeoRequests@dws.gov.za | the operator's catalogue download | – | the synthetic stations | – (never loaded in production) | operator; `pnpm import:gauge-stations`  |

### GR4J priors (issue #622)

Four sources feed the regional GR4J prior ([model.md §2.10m](./model.md)).
Each is a reference load: the operator downloads it, the app never fetches
it. Licences read on the publishers' own pages on 2026-10-28, against
Decision D-B.

- **GRDC-Caravan** (Färber, C., Plessow, H., Mischel, S., Kratzert, F.,
  Addor, N., Shalev, G. & Looser, U. (2025), *GRDC-Caravan: extending the
  original dataset with data from the Global Runoff Data Centre* (0.6),
  Zenodo, 10.5281/zenodo.15349031). **CC BY 4.0** on the record and in the
  archive's `licenses/grdc/license_grdc.md`, which adds "All hydrological
  data remain property of the owner". The per-country terms are in
  `licenses/grdc/LicensesCaravan.xlsx`, read from the archive itself
  (2026-10-28). Region D1 holds only South Africa's 434 stations and
  Namibia's 51: "South Africa - Department of Water and Sanitation (DWA) |
  Free to use | personal communication", and Namibia (Ministry of
  Agriculture, Water & Forestry) the same. Passes D-B: commercial use with
  attribution. The countries whose terms fail it (Belgium's
  non-commercial records, Czechia's CC BY-NC-ND 3.0, Brazil's CC BY-ND 3.0)
  are all outside D1, and `fit-donors.ts` takes only basins inside D1.
  **What we keep:** each donor's fitted parameters, scores and attributes.
  No flow is stored or shown, so the derived work is the parameter set. The
  fit never reads Caravan's ERA5-Land forcing: parameters absorb forcing
  bias, so a donor is refitted on our own CHIRPS v3 and dPET.
  Also cite Kratzert, F. et al. (2023), *Caravan, a global community
  dataset for large-sample hydrology*, Sci. Data 10, 61.
- **HydroATLAS v1.0**: **CC BY 4.0** (hydrosheds.org/hydroatlas). Cite
  Linke, S. et al. (2019), Sci. Data 6, 283, and Lehner, B. et al. (2022),
  *Global hydro-environmental lake characteristics at high spatial
  resolution*, Sci. Data 9, 351, as the page asks. The donors' attributes
  come inside GRDC-Caravan (`attributes_hydroatlas_grdc.csv`), so no
  download of its own until step 5. That step reads a target catchment's
  attributes from BasinATLAS. Its figshare copy's own licence field
  (10.6084/m9.figshare.9890531) is read when that download is added.
- **SoilGrids 2.0** water retention (Turek, M.E. et al. (2023), *Global
  mapping of volumetric water retention at 100, 330 and 15 000 cm suction
  using the WoSIS database*, ISWCR 11(2), 225–239). **CC BY 4.0** on both
  layers' records on data.isric.org (DOIs
  10.17027/isric-soilgrids.14e7c761-6f87-4f4c-9035-adb282439a44 and
  10.17027/isric-soilgrids.f5a1188a-09f8-4ef6-b841-93f08e3903f4). The water
  retention layers are **not** on the WebDAV share `files.isric.org`
  (`soilgrids/latest/data/` lists no `wv*`, checked 2026-10-28). Their
  records distribute them as GeoTIFFs at
  `storage.googleapis.com/isric-share-soilgrids/pre-release/wv0033/` and
  `…/wv1500/`, one per depth and statistic. We read the six `_mean`
  files of each. Units: 10⁻³ cm³/cm³, which is mm of water per m of soil.
  The REST API is paused and allowed 5 calls a minute; we never use it.
- **iSDAsoil** depth to bedrock (iSDA; Hengl, T. et al. (2021), Sci. Rep.
  11, 6130). **CC BY 4.0** on the AWS Registry of Open Data entry that iSDA
  manages. iSDA's own site links its Terms of Use without stating a data
  licence. The layer is
  `s3://isdasoil/soil_data/bedrock_depth/bedrock_depth.tif` (band 1, the
  predicted mean, cm, 0–200; EPSG:3857 at 30 m; its STAC item covers to
  34.89° S). A value of 200 means at least 200 cm. Some land is masked;
  `ingest/soils.py` takes a cell with no value as deep, and counts them.

Status: all four `reference load`, allowed in `load-reference.yml` (kinds
`soils` and `gr4j-donors`). The feature does nothing until the operator
loads them, and the synthetic grid and donors stand in for dev, CI and e2e.

## The copy's reference evaporation

Issue #604 R5-E: a current-season evaporation option beside dPET's
climatology (§ dpet below). GR4J reads it only under a monthly PE row,
as it stands ([model.md §2.4a](./model.md) *Daily reference ET*).

### agera5

- **Source:** AgERA5 v2.0, *Agrometeorological indicators from 1979 to
  present derived from reanalysis* (Copernicus C3S, CDS dataset
  `sis-agrometeorological-indicators`, DOI 10.24381/cds.6c68c9bb),
  variable `reference_evapotranspiration`: daily FAO-56 Penman-Monteith
  reference ET in mm/day on a 0.1° grid from 1979, computed from ERA5's
  2 m weather. v2.0 was published on the CDS on 2025-05-15 and added the
  reference ET layer; v1.1 is being deprecated
  ([forum](https://forum.ecmwf.int/t/new-agera5-version-2-now-available-on-the-cds/13088),
  read 2026-10-27). The dataset page gives a daily update, no latency; we
  assume about a week, **unverified until the first live run** (the
  request's exact form, the file's variable name and units are checked by
  the reader, which refuses anything else; `ingest/README.md`).
- **Host:** `cds.climate.copernicus.eu` (the CDS API).
- **Licence:** CC BY 4.0 ("CC-BY licence" on the dataset page, read
  2026-10-27). The dataset's licence is accepted once on the CDS account
  (operator step, #618 7b–7d), the same account and key as ERA5-Land's.
- **Attribution:** "Contains modified Copernicus Climate Change Service
  information [year]. Neither the European Commission nor ECMWF is
  responsible for any use that may be made of the Copernicus information or
  data it contains." and "Boogaard, H., Schubert, J., De Wit, A.,
  Lazebnik, J., Hutjes, R., Van der Grijn, G. (2020): Agrometeorological
  indicators from 1979 to present derived from reanalysis. Copernicus
  Climate Change Service (C3S) Climate Data Store (CDS). DOI:
  10.24381/cds.6c68c9bb". The array carries it (`attrs.attribution`); the
  feed card shows the credit (`et0Note`), and the series is labelled
  "AgERA5 daily reference evapotranspiration data feed".
- **Contact:** ECMWF support (CDS).
- **Access pattern:** the mirror-ingest Lambda once a day
  (`{"product":"agera5_et0","mode":"monthly"}`), ERA5-Land's
  submit-then-collect machinery: one CDS request per month for region D1,
  submitted on one run and collected on a later one, into Zarr
  `agera5_et0` (finals layout, 0.1°). A backfill names its month (from
  1979-01). Projects read it through `agera5_et0` data feeds in the
  worker's own job (`feeds/fromMirrorEt0.ts`), never from the CDS.
- **Limits we keep to:** as ERA5-Land's: at most one request per month and
  4 queued in all; one API call a second; a failed request backs off 1–8
  days and stops after 5; a 401/403 stops the run for the UTC day; never
  waits inside a Lambda.
- **Fallback:** [nasa-power](#nasa-power) for the newest days, and for any
  day AgERA5's copy doesn't hold; dPET's monthly climatology (the PE row)
  for every other day.
- **Owner:** the operator; code `ingest/agera5.py`, `infra/agera5.tf`.

### nasa-power

- **Source:** NASA Prediction of Worldwide Energy Resources (POWER),
  daily, Agroclimatology community: `T2M_MAX`, `T2M_MIN`, `T2MDEW`,
  `WS2M`, `ALLSKY_SFC_SW_DWN` (MJ/m²/day) and `PS`, on POWER's 0.5° grid
  (MERRA-2-based meteorology), 2 to 7 days behind ("Latency: 2 to 7 days
  depending on source provider",
  [power.larc.nasa.gov/llms.txt](https://power.larc.nasa.gov/llms.txt),
  read 2026-10-27). POWER publishes **no FAO-56 reference ET**: its
  parameter list (AG, daily) has only `EVLAND` and `EVPTRNS`, actual
  evaporation, so we compute ET₀ ourselves with FAO-56 eq. 6
  (`ingest/fao56.py`, tested against FAO-56 Examples 8 and 18).
- **Host:** `power.larc.nasa.gov` (the REST API's regional daily
  endpoint, no sign-in). The same data is on AWS
  (`registry.opendata.aws/nasa-power`, us-west-2), which we don't use yet.
- **Licence:** CC BY 4.0 (POWER's own summary,
  [llms.txt](https://power.larc.nasa.gov/llms.txt), read 2026-10-27). The
  AWS registry says "There are no restrictions on the use, access, and/or
  download of data from the NASA POWER Project. We request that you cite
  the NASA POWER Project when using the data"
  ([registry](https://registry.opendata.aws/nasa-power/), read
  2026-10-27). Commercial use allowed either way; we credit as CC BY asks,
  without implying NASA's endorsement.
- **Attribution:** "NASA Prediction of Worldwide Energy Resources (POWER)
  Project, CC BY 4.0; FAO-56 Penman-Monteith reference evapotranspiration
  computed by us from its daily meteorology", on the array and on the feed
  card when a fetch took days from it ("N newer days from NASA POWER").
  POWER's referencing guide is
  [power.larc.nasa.gov/docs/referencing](https://power.larc.nasa.gov/docs/referencing/).
- **Contact:** the POWER team, through the contact link on
  power.larc.nasa.gov and the Earthdata forum.
- **Access pattern:** the mirror-ingest Lambda once a day
  (`{"product":"power_et0","mode":"recent","days":30}`): the last 30 days
  ending three days ago, region D1 cut into tiles of at most 10° × 10°,
  **one parameter per request** (POWER's rule for regional requests), JSON.
  Each 0.1° cell takes the ET₀ of the POWER point nearest its centre. Into
  Zarr `power_et0` (daily layout, 0.1°), a rolling 120 days in the
  manifest.
- **Limits we keep to:** at most 1 request a second, one at a time, about
  70 requests a run (12 tiles × 6 parameters), one run a day; POWER sets no
  rate limit but monitors use and may restrict it (POWER team on the
  Earthdata forum), and warns that repeating requests for one place can get
  an application blocked, which one region-wide daily run avoids.
  `Retry-After` honoured; a 403 stops the run with no retry and a same-day
  marker.
- **Fallback:** AgERA5 once its month lands (the feed replaces POWER's days
  then); else the monthly PE row.
- **Owner:** the operator; code `ingest/nasapower.py`, `ingest/fao56.py`,
  `infra/agera5.tf`.

## Climate indices

The seasonal outlook's climate-state analogues (issue #620,
[model.md §2.15c](./model.md#215c-past-seasons-like-this-one-the-climate-state-analogues))
read two monthly indices from our own copy, never from CPC at run time.

### climate-indices

- **Source:** NOAA Climate Prediction Center. The **Oceanic Niño Index**
  (ONI, ERSSTv5): the 3-month running mean of the Niño 3.4 sea-surface
  temperature anomaly, `oni.ascii.txt`, one row per overlapping season from
  DJF 1950, published early in the month after a season ends. The
  **Antarctic Oscillation** (AAO): CPC's monthly index of the Southern
  Annular Mode (the leading pattern of 700 hPa height south of 20° S), from
  January 1979, published early in the following month. We keep each ONI
  season under its centre month (JAS → August).
- **Host:** `www.cpc.ncep.noaa.gov`, two plain-text files fetched whole:
  `/data/indices/oni.ascii.txt` and
  `/products/precip/CWlink/daily_ao_index/aao/monthly.aao.index.b79.current.ascii`.
- **Licence:** US-government work, not under copyright in the US; no
  licence terms on either page beyond NOAA's general disclaimer (read
  2026-10-27, issue #620). Commercial use allowed; D-B passes. We use CPC's
  AAO, **not** the Marshall (BAS) SAM index: its terms couldn't be found, so
  it stays out until BAS confirms them.
- **Attribution:** "ONI and AAO: NOAA Climate Prediction Center", shown under
  the outlook's Past seasons like this one with the months the copy holds and
  when it was read (each outlook stores the copy's manifest entry, docs/api.md
  § Seasonal outlooks).
- **Contact:** NOAA CPC (the contact link on www.cpc.ncep.noaa.gov).
- **Access pattern:** the fetcher's indices pass once a day
  (`{"mode":"daily-ingest","pass":"indices"}`, 05:50 UTC,
  `infra/climate_indices.tf`): each file fetched whole, parsed strictly (a
  changed page refuses the whole file), written to `indices/<id>.json` only
  when its values changed, and recorded in `indices/manifest.json` (URL,
  SHA-256, months held, revision, when fetched and changed). A file shorter
  than the copy's is refused and the copy's kept. The worker reads the copy
  when an outlook asks for it ([architecture.md § Data
  feeds](./architecture.md#data-feeds)).
- **Limits we keep to:** two requests a day, one a second, with the
  descriptive User-Agent; a 403 or throttle ends the run with no retry; at
  most 512 kB a file (both are under 40 kB).
- **Fallback:** the copy's last revision; the outlook reads a month or two
  earlier when this season's months aren't held yet, and otherwise says the
  indices aren't held and shows the ESP alone.
- **Owner:** the operator; code `backend/src/feeds/sources/cpc.ts`,
  `backend/src/ingest/indices.ts`, `infra/climate_indices.tf`. Freshness
  alarm `mirror-lag-indices` (MirrorLagDays{Product=indices} ≥ 75 days).
- **Fixtures:** invented values (`backend/src/feeds/sources/cpc.ts`
  `oniFixtureText`, `aaoFixtureText`, answered under `FEED_SOURCE=fixtures`)
  and the committed synthetic copy `backend/fixtures/mirror/indices/`
  (`pnpm gen:mirror-fixture`).

## Planned sources

From #604's Rounds 4 and 5. Each gets its full section here when its round
starts.

| Id | Licence | Attribution | Contact | Access pattern | Limits we keep to | Fallback | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <a id="era5-land"></a>era5-land | CC BY 4.0 ("CC-BY licence" on the dataset page, read 2026-10-27; Copernicus, since 2025-07-02); the licence is accepted once on the account (operator step) | wherever its values show (UI, reports, exports): "Contains modified Copernicus Climate Change Service information [year]. Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains." and the dataset citation, [below](#era5-land-r4-a) | ECMWF support (CDS); a CDS account and API key in `water-management/ingest/cds-key` (operator step) | CDS API (`reanalysis-era5-land`, `total_precipitation` at 00 UTC, area D1), one request a month into Zarr `era5l` (finals, 0.1°); submitted on one run, collected on a later one | at most one request per month and 4 queued in all; one API call a second; a failed request backs off 1–8 days and stops after 5; a 401/403 stops the run for the UTC day; never waits inside a Lambda | the CDS for the backfill too (`nsf-ncar-era5` holds ERA5, not ERA5-Land, checked 2026-10-27); NCAR GDEX d633008 has ERA5-Land (not used) | operator; `ingest/era5land.py`, `infra/era5land.tf` |
| <a id="sanlc"></a>sanlc | **gated:** fails D-B on the terms we could read (2013/14: no derivatives, no competing products); the 2018–2022 terms on EGIS still to be read (operator step) | "© GEOTERRAIMAGE" with the year, if allowed | DFFE (EGIS) | the operator's download, warped to EPSG:4326 and pre-summarised by `pnpm import:crop-types` into orchard, vine and new-planting shares per cell (maps.md § Orchards and vines from SANLC); local evaluation only, the production load (kind `crop-types`) refused until allowed | – | WorldCover | operator; R5-D |

### ERA5-Land (R4-A)

- **Source:** ERA5-Land hourly data from 1950 to present, ECMWF for the
  Copernicus Climate Change Service, 0.1° on the CDS; about 5 days behind
  real time as ERA5-Land-T (preliminary), consolidated about two months
  later. Product `era5l` in the copy: daily totals in mm, finals layout on
  the 0.1° grid (ingest/README.md § The ERA5-Land job).
- **Attribution, quoted exactly** (C3S's "How to acknowledge and cite a
  Climate Data Store (CDS) catalogue entry", read 2026-10-27; "Contains
  modified" because the copy remaps and converts it):
  > Contains modified Copernicus Climate Change Service information [year].
  > Neither the European Commission nor ECMWF is responsible for any use
  > that may be made of the Copernicus information or data it contains.

  and the dataset citation: "Muñoz Sabater, J. (2019): ERA5-Land hourly
  data from 1950 to present. Copernicus Climate Change Service (C3S) Climate
  Data Store (CDS). DOI: 10.24381/cds.e2161bac". `[year]` is the year the
  data were accessed. The copy's array carries the text in its
  `attribution` attribute (`era5land.ATTRIBUTION`). It must show wherever
  ERA5-Land's values do: the Data sources and credits page, a run's rain
  source, reports and evidence packs, and exports.

  **Where the credits show** (issue #604 R4-E), each from one place, the
  engine's `packages/engine/src/liability/rainCredits.ts` (`@water-management/engine/credits`, a module with no imports; `copernicusEra5lNotice`,
  `ERA5L_CITATION`, `imergCitation`, `ECMWF_CREDIT`, `rainCredits`,
  `runRainCredits`), word for word, with the day the values were read (a
  run's creation day; today on a live view): the Data sources and credits
  page (`/data-sources`, `legal/dataCredits.ts`); Data → Rain products side
  by side and the per-day preview, once a product's values show; Model
  quality's Rain gaps filled from other products (a run that read them); the
  run report's Inputs, **Rain data credits** (and an ECMWF forecast's cover
  line, `FORECAST_RAIN_NOTE`), which the server's report PDF prints; the
  run's CSVs (`# credit <name>: <text>` lines under the provenance line of
  the catchment's daily file and of catchment rain's series file, and
  `Credit:` rows in the summary's Gap-filling products block, `ECMWF` in its
  forecast block); the workbook's first sheet; and an evidence pack's
  reproduction bundle README (its series hold the products' values). A run
  on CHIRPS alone and an uploaded forecast print none of them; a forecast
  an ECMWF feed wrote only some days of (one edited by hand) still prints
  ECMWF's (the run's `forecastRainEcmwf`, backend `runs/execute.ts`).
- **How a day is defined:** the UTC day. ERA5-Land's `tp` accumulates from
  00 UTC, so the 00 UTC step of D+1 is the whole of day D, stored under D.
- **Against CHIRPS's day:** CHIRPS v3 splits pentad totals into days with
  ERA5's (`rnl`) or IMERG's (`sat`) daily fractions, both UTC days, so the
  same date is the same UTC day in both. But CHIRPS's pentad totals blend in
  gauges read in the local morning (about 06 UTC), so close to a pentad's
  edge a storm can sit a day apart in the two. Compare them over a pentad or
  longer, not day by day.
- **The grid:** ERA5-Land's points are on x.x0°, the copy's 0.1° cells are
  centred on x.x5°; each cell is the mean of its four corner points (the
  area-weighted remap), and a coastal cell the mean of its land corners
  (ERA5-Land has no values over sea).

## Candidates for Round 6 and later

Each becomes its own issue once Rounds 1–3 land, and gets a row in the
register before any code fetches it (#604 § Round 6 and later; research in
its comments 4, 6, 7 and 8).

| Source | Licence | Access | Use |
| --- | --- | --- | --- |
| C3S multi-system seasonal | CC BY, plus the additional licence for non-European contributions | CDS API, 1° monthly | seasonal outlook per restriction level |
| NEX-GDDP-CMIP6 | CC0 (NASA's expert-use caveat) | S3 us-west-2 | future yield in evidence packs |
| GloFAS v4 reanalysis | CEMS-FLOODS, free with attribution | EWDS API | modelled daily flow for ungauged catchments |
| WaPOR v3 actual ET | **contested** (CC BY-SA, CC BY-NC-SA, FAO terms); ask FAO first | `s3://wapor-v3/` af-south-1 | observed vs modelled water use; SSEBop at 1 km if FAO says no |
| Sentinel-1/2 water masks, SWOT lake heights | Copernicus free and open; SWOT terms unconfirmed | DE Africa STAC; PO.DAAC | small dams through cloud; area–volume curves (trial) |

## Rejected

| Source | Why not |
| --- | --- |
| Google Earth Engine | Free tiers are non-commercial; commercial use from $500/month; data would cross clouds |
| MSWEP | CC BY-NC 4.0 unless bought through GloH2O's API |
| TAMSAT, ARC2, PERSIANN, PDIR-Now as a CHIRPS fallback | Infrared-only: the same blind spot in winter frontal and orographic rain |
| HWSD, the Global Aridity Index, GMIA, the SA Fields of the World labels | Non-commercial licences |
| MERIT Hydro, FAO WaPOR v3 reference ET, DWS 1:500 000 rivers, the Lynch (2004) MAP grid | Fail D-B or unconfirmed: [maps.md § Sources](./maps.md#sources) |
| Reading CHC live, only slower | Bans are per address and by volume; a 16,000-file backfill per feed can't be made polite |
