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
| [deafrica-wofs-scenes](#deafrica-wofs-scenes) | DE Africa WOfS (`wofs_ls`, per Landsat scene) and its STAC search, summed inside our own dam outlines (built R5-C) | built; runs in the fetcher's `dams-weekly` mode, off in production until `dam_observations_enabled` | `explorer.digitalearth.africa`, `deafrica-services.s3.af-south-1.amazonaws.com` | – | `backend/src/dams/observed/wofs/` (`pass.ts`, `stac.ts`, `sum.ts`), `backend/src/raster/` (`cog.ts`, `mask.ts`, `utm.ts`) |
| [deafrica-sentinel-2-c1](#deafrica-sentinel-2-c1) | DE Africa Sentinel-2 L2A Collection 1 (`s2_l2a_c1`), our own water classification inside traced dam outlines (issue #624) | built, off by default (#624 step 4: the pass, behind `DAM_OBSERVATIONS_S2` / `dam_s2_enabled`; not shown on a screen yet) | `deafrica-sentinel-2-l2a-c1.s3.af-south-1.amazonaws.com`, `explorer.digitalearth.africa` | – | `backend/src/dams/observed/sentinel/` (`s2.ts`, `pass.ts`); `wofs/stac.ts` (`assetUrl`, `s2_l2a_c1`) |
| [deafrica-sentinel-1](#deafrica-sentinel-1) | DE Africa Sentinel-1 RTC (`s1_rtc`), radar water as a secondary dam observation (issue #624) | planned (#624; registered, the hosts allowed, `dam_observation` source `s1`; no pass reads it yet) | `deafrica-sentinel-1.s3.af-south-1.amazonaws.com`, `explorer.digitalearth.africa` | – | `backend/src/dams/observed/wofs/stac.ts` (`assetUrl`, `s1_rtc`); #624 `sentinel/s1.ts` |
| [wapor-aeti](#wapor-aeti) | FAO WaPOR v3 `L2-AETI-D`, dekadal actual ET and interception at 100 m (a unit's observed water use, issue #623) | built, off (`et_observations_enabled`); blocked in production until FAO's reply is recorded on #618 (step 8a) | `storage.googleapis.com` (bucket `fao-gismgr-wapor-3-data` only) | – | `backend/src/water-use/observed/` (`wapor.ts`, `pass.ts`; the comparison is #623 step 5) |
| [ssebop-eta](#ssebop-eta) | USGS FEWS NET SSEBop v6.1 global dekadal actual ET at 1 km (WaPOR's fallback, issue #623) | planned (#623 step 6, only if FAO declines or as a second opinion) | `edcintl.cr.usgs.gov` (the `…/global/dekadal/etav61/` tree only) | – | `backend/src/water-use/observed/upstream.ts` |
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
| [hydroatlas](#hydroatlas) | HydroATLAS v1.0 basin attributes (BasinATLAS; the donors' copy comes inside GRDC-Caravan) | reference load (the donors' attributes; a target's, from BasinATLAS, still to come: followups.md § Regional GR4J prior) | `zenodo.org` (inside GRDC-Caravan); `figshare.com` (BasinATLAS) | – | `backend/scripts/fit-donors.ts` |
| [soilgrids](#soilgrids) | SoilGrids 2.0 water retention, `wv0033` and `wv1500` at six depths to 200 cm (the soil water capacity grid) | reference load | `storage.googleapis.com` (bucket `isric-share-soilgrids`) | – | `ingest/soils.py`, `pnpm import:soils` (kind `soils`) |
| [isdasoil](#isdasoil) | iSDAsoil v1 depth to bedrock (the soil grid's root depth) | reference load | `s3://isdasoil` (us-west-2) | – | `ingest/soils.py`, `pnpm import:soils` (kind `soils`) |
| [quaternaries](#quaternaries) | Quaternary outlines and WR2012 values | blocked | `www.dws.gov.za`, WRC (the operator's download) | – | `pnpm import:quaternaries` |
| [dam-register](#dam-register) | DWS List of Registered Dams and its overlay | blocked | `www.dws.gov.za` | – | `pnpm import:dam-register` |
| [gauge-stations](#gauge-stations) | DWS hydrological station catalogue | blocked | `www.dws.gov.za` | – | `pnpm import:gauge-stations` |
| [dws-evaporation](#dws-evaporation) | DWS evaporation station records (Class-A and Symons pans, verified daily) | built (#646 item 6); blocked in production until DWS's permission covers them (synthetic stations in dev, CI and e2e) | `www.dws.gov.za` (the operator's request; never fetched) | – | `backend/src/geo/dwsEvaporation.ts`, `backend/src/geo/evaporationStations.ts`, `pnpm import:evaporation-stations` |
| [era5-land](#era5-land) | ERA5-Land daily precipitation | built R4-A; off until `era5l_enabled` (the operator's CDS key first) | `cds.climate.copernicus.eu` (backfill too) | – | `ingest/era5land.py`, `infra/era5land.tf` |
| [ecmwf-ens](#ecmwf-ens) | ECMWF open data ENS 15-day precipitation (0.1°) | built (R4-C); the copy's job off in production until `ecmwf_enabled` | `ecmwf-forecasts.s3.eu-central-1.amazonaws.com` | `ecmwf_ens` | `ingest/ecmwf_forecast.py` (the copy), `ingest/ecmwf_qm_fit.py` (the fit), `backend/src/feeds/fromMirrorEcmwf.ts` (feeds read it) |
| [imerg](#imerg) | IMERG Late V07 daily (GSMaP Gauge-NRT second) | the copy built (R4-D), off until `imerg_enabled` (needs the operator's Earthdata login or token) | `cmr.earthdata.nasa.gov`, `opendap.earthdata.nasa.gov`, `urs.earthdata.nasa.gov` (token API, stored login only) | – | `ingest/imerg.py`, `infra/imerg.tf` |
| [sanlc](#sanlc) | SANLC orchard and vine classes | built R5-D; blocked in production until its terms are recorded (synthetic grid in dev, CI and e2e) | `egis.environment.gov.za` | `crop_type_dataset` | `pnpm import:crop-types` |
| [agera5](#agera5) | AgERA5 v2.0 daily FAO-56 reference ET | built R5-E; the copy's job off in production until `agera5_enabled` (the CDS key is ERA5-Land's) | `cds.climate.copernicus.eu` | `agera5_et0` | `ingest/agera5.py` (the copy), `backend/src/feeds/fromMirrorEt0.ts` (feeds read it), `infra/agera5.tf` |
| [nasa-power](#nasa-power) | NASA POWER daily weather, our FAO-56 ET₀ from it (AgERA5's fallback) | built R5-E; off until `power_et0_enabled` | `power.larc.nasa.gov` | – (read by `agera5_et0` feeds) | `ingest/nasapower.py`, `ingest/fao56.py`, `infra/agera5.tf` |
| [penpan-apan](#penpan-apan) | A modelled Class-A pan grid: PenPan from NASA POWER's daily weather, monthly means at 0.1° (issue #646 item 7) | blocked (built against synthetic weather; production waits for the validation against DWS Class-A pans and the hydrologist's sign-off) | `power.larc.nasa.gov` (the operator's offline run) | – | `ingest/penpan.py`, `ingest/apan_grid.py`, `pnpm import:evaporation` (kind `apan`) |
| [climate-indices](#climate-indices) | NOAA CPC's ONI (ENSO) and AAO (the SAM's proxy), monthly | built (#620); the fetcher's indices pass off in production until `climate_indices_enabled` | `www.cpc.ncep.noaa.gov` | – | `backend/src/feeds/sources/cpc.ts`, `backend/src/ingest/indices.ts`, `infra/climate_indices.tf` |
| [c3s-seasonal](#c3s-seasonal) | C3S multi-system seasonal forecasts and hindcasts, daily precipitation (1°) | built (#620 step 5); the copy's job off in production until `c3s_enabled` (the CDS key is ERA5-Land's; both licences accepted first); nothing reads it yet (#620 step 6–7) | `cds.climate.copernicus.eu` | – | `ingest/c3s_seasonal.py`, `ingest/c3srequest.py`, `infra/c3s.tf` |
| [nex-gddp-cmip6](#nex-gddp-cmip6) | NASA NEX-GDDP-CMIP6 daily downscaled projections (`pr`, `tasmax`, `tasmin`; 0.25°), for future yield (issue #621) | registered (slice 1); a one-off static load, monthly aggregates for region D1 only, still to be built (slice 2) and off in the app until the copy holds `cmip6` | `s3://nex-gddp-cmip6` (us-west-2, anonymous) | – | `ingest/cmip6_delta.py` (slice 2), the engine's `scenario/climate.ts` (the factors) |

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
  Sentinel-2 and Sentinel-1 ([deafrica-sentinel-2-c1](#deafrica-sentinel-2-c1),
  [deafrica-sentinel-1](#deafrica-sentinel-1)): Sentinel-2's pass is built
  (#624 step 4) but off by default, Sentinel-1's not yet. The values already
  loaded stay in `dam_observation`.
- **Offline:** `FEED_SOURCE=fixtures` answers STAC and the scenes from
  invented ones (`backend/fixtures/feeds/wofs-sample.json`,
  `wofs/fixtures.ts`), so dev, CI and e2e never reach either host.
- **Owner:** the operator; code `backend/src/dams/observed/wofs/`.

### deafrica-sentinel-2-c1

- **Source:** Copernicus Sentinel-2 Level-2A surface reflectance, Collection 1
  reprocessing, as Digital Earth Africa publishes it (collection
  `s2_l2a_c1`): one item per scene and MGRS tile, cloud-optimised GeoTIFFs in
  UTM, bands B03 and B08 at 10 m, B11 and the SCL scene classification at
  20 m, updated daily (Sentinel-2A, 2B and 2C). DE Africa publishes no
  Sentinel water mask (its only water product is `wofs_ls`), so we classify
  the pixels ourselves: MNDWI from B03 and B11, NDWI from B08 where B11 is
  missing, SCL masking cloud, shadow and no data (issue #624 § Design).
- **Hosts:** `deafrica-sentinel-2-l2a-c1.s3.af-south-1.amazonaws.com` (the
  bucket, anonymous range reads, same region as the app; objects under
  `sentinel-2-c1-l2a/<utm zone>/<latitude band>/<grid square>/<year>/<month>/<scene id>/`,
  DE Africa's spec page, read 2026-10-29) and
  `explorer.digitalearth.africa` (the STAC search, as for WOfS). Both are in
  `FEED_HOSTS`; a `s2_l2a_c1` item's asset may only name a
  `sentinel-2-c1-l2a/…tif` key in that bucket (`stac.ts` `assetUrl`), and
  no other collection's item may name one.
- **Licence:** Copernicus Sentinel data is "free, full and open" under the
  EU's legal notice on the use of Copernicus Sentinel data and service
  information (Regulation (EU) No 1159/2013; read 2026-10-27). DE Africa's
  spec pages state no separate licence and link to the Copernicus terms.
  Commercial use and derived products are allowed with the credit below, so
  D-B is met.
- **Attribution:** "Contains modified Copernicus Sentinel data [year],
  processed by Digital Earth Africa" ([year] the years of the values shown)
  wherever Sentinel values show: the *Seen from space* panel, the farm dam
  card, evidence packs and `/data-sources`.
- **Contact:** Digital Earth Africa's help desk and community forum
  (digitalearthafrica.org; docs.digitalearthafrica.org); the Copernicus
  Data Space Ecosystem for the data itself.
- **Access pattern:** a pass in the fetcher's `dams-weekly` mode after
  WOfS (`sentinel/pass.ts`, WOfS's `runScenePass`), with its per-dam state
  (`dams/s2-state.json`), deadline and pacing: one STAC search per year
  window over the outline's snapped box, then three COG headers and three
  windowed reads a scene (B03, B11, SCL; B08 too only where B11 is
  missing), never a whole scene; the history backfills newest first to
  2019 (Collection 1 is consistent from there). Off until
  `DAM_OBSERVATIONS_S2=on` on the fetcher (Terraform `dam_s2_enabled`, with
  `dam_observations_enabled`). Asset keys and offsets checked against a
  live item 2026-10-29: `green` B03, `nir` B08, `swir16` B11, `scl` SCL,
  each band `raster:bands` nodata 0 and offset −1000 (SCL none), EPSG
  327xx.
- **Limits we keep to:** at most one request a second per host (the
  explorer, shared with the WOfS pass, and the bucket), one in flight,
  feeds/http.ts's User-Agent, host allowlist, 20 s timeout and 4 MB cap; a
  403 or 429/503 stops the pass and pauses it a day, never retried.
- **Limits of the data:** 10 m (B11 and SCL 20 m), about a 5-day revisit
  from 2019 (the backfill's start); optical, so cloud still hides a dam on a
  winter day, which is what Sentinel-1 is for.
- **Freshness:** its own heartbeat (`DamPassCompleted{Source=s2}`, 18 h)
  and recency (`DamObservationAgeDays{Source=s2}`, `dam_s2_recency_alarm_days`,
  21 by default) alarms, both breaching on missing data
  (`infra/dam_observations.tf`).
- **Rows kept:** `dam_observation` source `s2` (migration
  `278_dam_observation_sentinel.sql`): per dam and date, the wet pixels ×
  the 10 m pixel's ground area and the share of the outline seen clearly
  (model.md §2.10l).
- **Fallback:** WOfS (30 m) for the same dates; the S1 radar view through
  cloud.
- **Offline:** synthetic scenes only (`sentinel/fixtures.ts`,
  `backend/fixtures/feeds/s2-sample.json`); dev, CI and e2e never reach the
  bucket.
- **Owner:** the operator; code `backend/src/dams/observed/` (#624).

### deafrica-sentinel-1

- **Source:** Copernicus Sentinel-1 radiometrically terrain-corrected
  backscatter as Digital Earth Africa publishes it (collection `s1_rtc`):
  VV and VH gamma0, float32, on a 0.0002° geographic grid (EPSG:4326, not
  UTM), with a `mask` band flagging layover and shadow; from 2018, every 6–12
  days (Sentinel-1D items were present from 2026-09-05, so the 6-day
  revisit is back). Water is VV below −18 dB inside the outline, a fixed
  threshold (issue #624 § Design).
- **Hosts:** `deafrica-sentinel-1.s3.af-south-1.amazonaws.com` (the bucket,
  anonymous, same region as the app; objects under
  `s1_rtc/<tile id>/<year>/<month>/<day>/<datatake id>/`, DE Africa's spec
  page, read 2026-10-29) and `explorer.digitalearth.africa` (the STAC
  search). Both are in `FEED_HOSTS`; an `s1_rtc` item's asset may only name
  an `s1_rtc/…tif` key in that bucket (`stac.ts` `assetUrl`).
- **Licence:** as [deafrica-sentinel-2-c1](#deafrica-sentinel-2-c1):
  Copernicus "free, full and open" (read 2026-10-27).
- **Attribution:** "Contains modified Copernicus Sentinel data [year],
  processed by Digital Earth Africa", wherever its values show.
- **Contact:** as Sentinel-2's.
- **Access pattern (planned, #624 step 5):** a pass after Sentinel-2's, two
  windowed reads a scene (VV and `mask`), with the same state, deadline and
  pacing.
- **Limits we keep to:** as Sentinel-2's.
- **Limits of the data:** secondary only. Radar sees through cloud, but
  wind roughens open water so it looks dry, and dry sand can look wet, so an
  S1 view is shown as radar and never alone sets "seen full" or "seen
  empty"; hilly dams with layover get none. It is enabled for a dam only
  where its same-day agreement with Sentinel-2 clear views passes the bar in
  #624's acceptance criteria (≥ 85 % of days within 0.1 F).
- **Freshness (planned):** its own heartbeat and recency alarm.
- **Rows kept:** `dam_observation` source `s1` (migration
  `278_dam_observation_sentinel.sql`); none written yet.
- **Fallback:** Sentinel-2 and WOfS on clear days.
- **Offline:** synthetic scenes only (#624 step 5).
- **Owner:** the operator; code `backend/src/dams/observed/` (#624).

## Observed actual evapotranspiration

Satellite actual ET (ETa) over each unit's farm parcels, an independent
check on its modelled irrigation use (issue #623). Built for WaPOR: the store
(`et_observation`, migration 277), the fetcher's `et-dekadal` mode, the
handover and the worker's tick (step 4, [architecture.md § Observed actual
ET](./architecture.md#observed-actual-et)); the comparison is step 5. It follows the dam
observations' pattern: out of the VPC, through the mirror bucket, loaded by
the worker. Off by default (`ET_OBSERVATIONS=off`, Terraform
`et_observations_enabled`), and dev, CI and e2e read a synthetic file only.

### wapor-aeti

- **Source:** FAO WaPOR v3, mapset `L2-AETI-D` (actual evapotranspiration
  and interception, level 2, dekadal): 100 m (1/1024°, EPSG:4326), Africa
  and the Near East, from January 2018. int16 × 0.1 mm/day, nodata −9999.
  One BigTIFF COG per dekad, about 2.1 GB (512-pixel tiles, LZW).
- **Host:** `storage.googleapis.com`, FAO's own public bucket
  `fao-gismgr-wapor-3-data`, anonymous HTTPS:
  `DATA/WAPOR-3/MAPSET/L2-AETI-D/WAPOR-3.L2-AETI-D.<YYYY-MM-Dn>.tif`
  (`water-use/observed/upstream.ts` `WAPOR_BASE`). The host serves every
  public bucket on Google Cloud Storage, so `FEED_HOSTS` holds it with a
  path limit (`FEED_HOST_PATHS`, `feeds/http.ts`): a live fetch, or a
  redirect, may ask only paths under `/fao-gismgr-wapor-3-data/`. The
  `s3://wapor-v3/` bucket (af-south-1) refused anonymous list and get
  (AccessDenied, 2026-10-27), so it isn't used.
- **Licence** (read 2026-10-27): FAO's [statistical database terms of
  use](https://www.fao.org/contact-us/terms/db-terms-of-use) list WaPOR in
  **Annex 1**, under **CC BY 4.0** "unless specified otherwise in their
  metadata"; the mapset's metadata (FAO's GISMGR API,
  `catalog/workspaces/WAPOR-3/mapsets/L2-AETI-D`) names no other licence
  (`additionalInfo` empty, re-checked 2026-10-29). That exception is per
  mapset and is used: `L1-RET-M`'s own citation says "License: CC BY-NC-SA
  4.0", which is why reference ET is rejected ([maps.md §
  Sources](./maps.md#sources)). So re-check `L2-AETI-D`'s metadata before
  enabling, and ask FAO to confirm it covers this mapset. The same terms bar using the data "for or in conjunction with
  the promotion of a commercial enterprise", which we read as a bar on
  advertising with it, not on commercial use (D-B's test), and ask FAO to
  confirm. Two other labels exist: Digital Earth Africa labels its copy
  CC BY-SA 4.0, and older FAO material says CC BY-NC-SA 3.0 IGO. Either
  would fail D-B. So the email to FAO (#618 step 8a) confirms a likely
  CC BY 4.0 rather than settling an open question: the code may be built
  now, and **production waits on FAO's reply** being recorded on #618
  before `et_observations_enabled = true` with WaPOR.
- **Attribution:** "FAO WaPOR v3, CC BY 4.0"
  (`water-use/observed/upstream.ts` `WAPOR_ATTRIBUTION`) wherever an ETa
  value shows: the unit drawer's panel, reports, CSVs, and `/data-sources`.
- **Contact:** FAO's WaPOR team, through the WaPOR portal's contact (the
  address #618 step 8a writes to).
- **Access pattern** (`water-use/observed/pass.ts`): never a whole file. Per unit with
  parcels and per dekad, the BigTIFF header, the slice of the TileOffsets
  and TileByteCounts arrays for the tile rows under the parcels' bounding
  box (not the whole ~2.8 MB array), then those tiles: the header once a
  dekad, then about 3 range requests a unit. Each file's ETag is checked
  again 30 days after it was read, by a conditional GET of the header (a 304
  costs one request); a changed ETag on a dekad already read (FAO rewrites
  files: `updated` 2026-05 on 2025 files) means a re-read and a new revision
  of that dekad's rows. Only units with parcels are read. The band scale
  must read 0.1 with no offset, or the file is refused.
- **Limits we keep to:** one request a second, one connection;
  feeds/http.ts's User-Agent, host and path allowlist, 20 s timeout and
  4 MB cap per response; a 403 stops the pass, never retried, and a
  429/503 pauses the host for its `Retry-After`.
- **Freshness:** a dekad appears about 3 days after it ends (2026-10-D2 was
  written 2026-10-23, checked 2026-10-29). The pass's heartbeat
  (`EtPassCompleted`, 18 h) and recency (`EtObservationAgeDays`, 30 days)
  alarms treat missing data as breaching (`infra/et_observations.tf`).
- **Rows kept:** per unit and dekad, the area-weighted mean ETa (mm/day)
  over the unit's parcels (∩ WorldCover cropland where loaded, else the
  whole parcel, labelled), and the share of the area with a valid pixel
  ([data-model.md § Observed actual ET](./data-model.md#observed-actual-et)).
- **Fallback:** [ssebop-eta](#ssebop-eta). The values already loaded stay.
- **Offline:** `FEED_SOURCE=fixtures` serves a synthetic BigTIFF over the
  seeded examples' parcels (`water-use/observed/fixtures.ts`,
  `fixtures/feeds/wapor-sample.json`), so dev, CI and e2e never reach the
  host.
- **Owner:** the operator; code `backend/src/water-use/observed/`.

### ssebop-eta

- **Source:** USGS FEWS NET's global SSEBop actual ET, version 6.1
  (VIIRS-based), dekadal, 1 km (1/96°), from 2012-02 (the listing checked
  2026-10-29 runs `d2012021.zip` to `d2026102.zip`, the last written
  2026-10-22). Each dekad is a zip, about 93 MB, holding one GeoTIFF.
  Dataset: doi:10.5066/P9QJWQ6K.
- **Host:** `edcintl.cr.usgs.gov`, under
  `/downloads/sciweb1/shared/fews/web/global/dekadal/etav61/downloads/dekadal/d<YYYYMMD>.zip`
  (`water-use/observed/upstream.ts` `SSEBOP_BASE`). The host carries much
  else of FEWS NET's, so `FEED_HOST_PATHS` keeps a live fetch to the
  `…/global/dekadal/etav61/` tree. The older `etav6/` tree stops at
  `d2024042` and isn't used.
- **Licence:** **CC0** (USGS; read 2026-10-27, the dataset's ScienceBase
  record). No operator step.
- **Attribution:** not required; we credit it anyway, "USGS FEWS NET SSEBop
  v6, CC0" (`SSEBOP_ATTRIBUTION`), wherever its values show.
- **Contact:** USGS EROS (FEWS NET's early-warning team,
  earlywarning.usgs.gov).
- **Access pattern:** only if FAO declines, or as a second opinion (#623
  step 6). A zip isn't a COG: its GeoTIFF can't be range-read by tile, and
  one dekad is far over the live client's 4 MB cap. So the SSEBop slice
  decides between a whole-file read in a bounded pass (one file a dekad,
  conditional on the ETag, clipped to the catchments' box at once) and a
  reference load; that is its design question, not settled here.
- **Limits we keep to:** one request a second, one connection; feeds/http.ts's
  allowlist and User-Agent; a 403 stops the pass.
- **Fallback:** none at 1 km and dekadal; the modelled use stands unchecked.
- **Owner:** the operator; code `backend/src/water-use/observed/` (#623
  step 6).

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
  `data.gesdisc.earthdata.nasa.gov`; we don't fetch it. With the login
  stored instead of a token, `urs.earthdata.nasa.gov`'s user token API
  (`/api/users/tokens`, `/api/users/token`, `/api/users/revoke_token`, HTTP
  Basic; [EDL](https://urs.earthdata.nasa.gov/documentation/for_users/user_token),
  read 2026-10-28) too: one list a run, a create only when the token in use
  has 7 days or fewer left, paced at one a second (`ingest/earthdata.py`).
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
  and the Earthdata forum. Needs an Earthdata Login account, with its login
  (the job renews its own token) or a user token (60 days, rotated by hand)
  in the secret (operator step, docs/deployment.md § IMERG Late).
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
- **Access pattern:** the copy only (`ingest/ecmwf_forecast.py`, the Python ingest
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
- **Owner:** the operator; code `ingest/ecmwf_forecast.py`, `ingest/ecmwf_qm_fit.py`,
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
| <a id="hydroatlas"></a>hydroatlas | CC BY 4.0 ("The HydroATLAS database is licensed under a Creative Commons Attribution (CC-BY) 4.0 International License", hydrosheds.org/hydroatlas, read 2026-10-28) | "Basin attributes: HydroATLAS v1.0 (BasinATLAS; Linke et al. 2019, Lehner et al. 2022), CC BY 4.0." | hydrosheds.org | the donors': GRDC-Caravan's `attributes_hydroatlas_grdc.csv`, no download of its own; a target's: BasinATLAS v1.0 (figshare 10.6084/m9.figshare.9890531), one download, still to come (followups.md § Regional GR4J prior) | none fetched by the app | the files in the reference bucket | with the donors (`gr4j_donor`) | operator; `backend/scripts/fit-donors.ts` |
| <a id="soilgrids"></a>soilgrids | CC BY 4.0: the layers' own records on data.isric.org (wv0033 `14e7c761-6f87-4f4c-9035-adb282439a44`, wv1500 `f5a1188a-09f8-4ef6-b841-93f08e3903f4`: "Attribution 4.0 International (CC BY 4.0)") and ISRIC's SoilGrids FAQ ("SoilGrids products are provided under the CC BY 4.0"), read 2026-10-28 | "Soil water retention: SoilGrids 2.0 © ISRIC – World Soil Information, CC BY 4.0."; cite Turek et al. (2023) | soilgrids@isric.org | the twelve mean GeoTIFFs (two properties × six depths, about 2.2 GB each), read by GDAL over HTTP for region D1 only, by the operator | twelve files a refresh; the REST API is not used (paused, and 5 calls a minute) | the resampled grids in the reference bucket; the synthetic grid locally | `soil_dataset` (source, version, method); `reference_load` (kind `soils`) | operator; `ingest/soils.py` |
| <a id="isdasoil"></a>isdasoil | CC BY 4.0 (the AWS Registry of Open Data entry iSDA manages, registry.opendata.aws/isdasoil: "License: CC-BY 4.0", read 2026-10-28) | "Depth to bedrock: iSDAsoil © Innovative Solutions for Decision Agriculture (iSDA), CC BY 4.0."; the registry asks for "iSDAsoil was accessed on DATE from https://registry.opendata.aws/isdasoil" | iSDA (isda-africa.com) | one cloud-optimised GeoTIFF (`soil_data/bedrock_depth/bedrock_depth.tif`, 23.6 GB, EPSG:3857), read by GDAL for region D1 at its overviews | one file a refresh | the resampled grid in the reference bucket | with the soil grid (`soil_dataset`) | operator; `ingest/soils.py` |
| <a id="quaternaries"></a>quaternaries | **blocked:** DWS outlines' commercial terms unconfirmed; WR2012 redistribution terms unpublished | DWS; WR2012 (WRC 2015) | DWS; WRC | the operator's download, loaded into the operator's own database only | – | the synthetic fixture everywhere else | – (never loaded in production) | operator; `pnpm import:quaternaries`  |
| <a id="dam-register"></a>dam-register | **blocked:** no terms on the DSO page; DWS's general terms are non-commercial | "Department of Water and Sanitation" | DWS Dam Safety Office | the operator's XLS and KMZ download | – | the synthetic list | – (never loaded in production) | operator; `pnpm import:dam-register`  |
| <a id="gauge-stations"></a>gauge-stations | **blocked:** unconfirmed (the Verified pages answer 403 outside South Africa) | "Department of Water and Sanitation" | GeoRequests@dws.gov.za | the operator's catalogue download | – | the synthetic stations | – (never loaded in production) | operator; `pnpm import:gauge-stations`  |
| <a id="dws-evaporation"></a>dws-evaporation | **blocked:** DWS's permission recorded 2026-10-28 ([dws-flow](#dws-flow)) covers verified daily **flow** only; evaporation station records (a weather station's `E` code, `HyData.aspx` with `SiteType=MET`) need it extended, asked for by the operator through the client's hydrologist (the draft: [legal/dws-evaporation-request.md](./legal/dws-evaporation-request.md); followups.md, *Decision: DWS evaporation station records*) | "Department of Water and Sanitation" as the copyright owner, and the station, its pan and the reply's reference in every revision that uses one | GeoRequests@dws.gov.za | the operator's data request: the per-area station lists (`Verified/dwafapp2_wma/WMA*_Met.pdf`, `[A]`/`[S]` pan) and one daily reply per station, loaded with `pnpm import:evaporation-stations` into the operator's own database only | – (the app never asks DWS) | the synthetic stations (`backend/fixtures/evaporation-stations/`) | `evaporation_station_reference` (dataset, source); – (never loaded in production: the release gate and the migrate Lambda refuse kind `evaporation-stations`) | operator; [maps.md § Evaporation stations](./maps.md#evaporation-stations) |

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

### penpan-apan

A **modelled** Class-A pan grid for Evaporation from the map's A-pan row
where no pan station is near (issue #646 item 7, the hydrologist review's
F5). Not a measured pan, and labelled so wherever it shows.

- **Source:** our own computation. PenPan (Rotstayn, Roderick and Farquhar
  2006, GRL 33, L17715), Penman's combination equation set up for a US
  Class-A pan (Linacre's radiation on the pan and its walls, Thom et al.'s
  vapour transfer), followed step by step as McMahon et al. (2013, HESS 17,
  1331, Supplement S6, eqs. S6.1–S6.6) write it, from NASA POWER's daily
  weather (the six parameters [nasa-power](#nasa-power) reads), as monthly
  means. Why POWER and not AgERA5: the copy holds only each one's reference
  ET, and adding AgERA5's other variables is five more CDS products, not a
  small change (`ingest/apan_grid.py`'s docstring). PenPan-V2 (Lim et al.
  2016) is not implemented: its equations could not be confirmed from a
  readable copy (docs/followups.md, #646).
- **Host:** `power.larc.nasa.gov`, the daily regional API, asked by the
  operator's offline run (`apan_grid.py fetch`), never by the app or the
  ingest Lambda.
- **Licence:** POWER's CC BY 4.0 ([nasa-power](#nasa-power)); the model and
  the grid are ours.
- **Attribution:** "NASA Prediction of Worldwide Energy Resources (POWER)
  Project, CC BY 4.0; Class-A pan evaporation modelled by us with PenPan
  (Rotstayn et al. 2006) from its daily meteorology", stored on the dataset
  row. Its source always starts "Modelled Class-A pan (PenPan)", so the
  proposal, the revision's reason and an evidence pack say modelled.
- **Contact:** the POWER team ([nasa-power](#nasa-power)).
- **Access pattern:** `apan_grid.py fetch --years 1991 2020`: for each year,
  each tile of the box (South Africa's: 4) and each parameter one request,
  24 a year, 720 for a 30-year normal, each year reduced to monthly means and
  kept (`<year>.power-monthly.json`), so a cut-short run resumes.
- **Limits we keep to:** as nasa-power's: one request a second through the
  polite client, one at a time, a 403 or 401 stops the run with no retry.
  One run per refresh of the normal.
- **Status: blocked.** Built and tested against synthetic weather
  (`power_fixture.FakePower`) and invented stations. Production waits for
  two things: `apan_grid.py validate`'s report against DWS Class-A pan
  stations (their monthly means; needs DWS's permission to cover evaporation
  station records, #646 item 6), and the hydrologist's sign-off on it. Until
  then the release gate (`map-data-gates.mjs`, a PenPan or A-pan key or label)
  and the migrate Lambda (any grid not `et0`, `referenceLoad.ts`) refuse it.
  Locally `pnpm import:evaporation` loads it (docs/maps.md § The evaporation
  grid).
- **Fallback:** the A-pan row typed by hand, or a daily A-pan record
  (model.md §2.3a).
- **Owner:** the operator; code `ingest/penpan.py`, `ingest/apan_grid.py`.

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

## Seasonal forecasts

The seasonal outlook's forecast-conditioned chances (issue #620 steps 5–7)
read C3S's multi-system seasonal forecasts from our own copy. Step 5 builds
the copy; nothing in the app reads it yet.

### c3s-seasonal

- **Source:** the Copernicus Climate Change Service (C3S) multi-system
  seasonal forecasts, CDS dataset `seasonal-original-single-levels`
  (*Seasonal forecast daily and subdaily data on single levels*, DOI
  10.24381/cds.181d637e), variable `total_precipitation` (24 h
  accumulations since the start), every member, leads 24 h to 5160 h (215
  days), the CDS's native 1° grid. One system per contributing centre
  (`ingest/c3srequest.py` `SYSTEMS`: ECMWF 51, Met Office 604,
  Météo-France 9, DWD 22, CMCC 35, NCEP 2, JMA 3, ECCC 4 and 5; C3S changes
  a centre's system from time to time and the table is updated by hand).
  Released once a month: ECMWF's on the 6th at 12 UTC, the other centres'
  on the 10th at 12 UTC (the dataset page, read 2026-10-28). **Hindcasts**
  for 1993–2016, the multi-system's common period, from the same dataset:
  one request per system per init calendar month, every year at once.
  The dataset page lists GRIB as its format; the reader decodes GRIB with
  eccodes and refuses anything but the request's own fields. The request's
  exact form (and whether the CDS takes a whole hindcast month in one
  request) is **unverified until the first live run**.
- **Host:** `cds.climate.copernicus.eu` (the CDS API).
- **Licence:** CC BY 4.0 ("CC-BY licence" on the dataset page) **plus the
  *Additional licence to use non European contributions***, both read
  2026-10-28 on the dataset page. The additional licence covers the
  centres outside Europe (NCEP, JMA, ECCC): the source must be
  acknowledged; there is no guarantee of continuity or quality, and no
  liability. The multi-system data "may be used and redistributed without
  restrictions" otherwise (issue #620, read 2026-10-27). Commercial use
  allowed; D-B passes. Both licences are accepted once on the CDS account
  that holds ERA5-Land's key (operator step, [deployment.md § C3S seasonal
  forecasts](./deployment.md#c3s-seasonal-forecasts)).
- **Attribution:** wherever its values show, Copernicus's notice
  "Contains modified Copernicus Climate Change Service information [year].
  Neither the European Commission nor ECMWF is responsible for any use that
  may be made of the Copernicus information or data it contains.", the
  citation "Copernicus Climate Change Service, Climate Data Store (2018): Seasonal forecast daily and subdaily data on single levels. Copernicus Climate Change Service (C3S) Climate Data Store (CDS). DOI: 10.24381/cds.181d637e",
  and the contributing centres of the systems used: European Centre for
  Medium-Range Weather Forecasts (ECMWF), Met Office, Météo-France,
  Deutscher Wetterdienst (DWD), Euro-Mediterranean Center on Climate Change
  (CMCC), NOAA National Centers for Environmental Prediction (NCEP), Japan
  Meteorological Agency (JMA), Environment and Climate Change Canada
  (ECCC). The engine holds these words (`liability/rainCredits.ts`
  `c3sSeasonalCredit`, for the outlook panel in step 7) and every array of
  the copy carries them (`credit`, `citation`, `centres`, `licence`).
- **Contact:** ECMWF support (CDS).
- **Access pattern:** the mirror-ingest Lambda once a day at 13:00 UTC
  (`{"product":"c3s","mode":"monthly"}`, `infra/c3s.tf`), ERA5-Land's
  submit-then-collect machinery keyed by request: per system, the newest
  released init (and one missed before it at most), submitted on one run
  and collected on a later one, into Zarr `c3s/<YYYY-MM>/tp_mm` (system,
  member, lead day, lat, lon; mm/day de-accumulated). The hindcasts by
  `{"product":"c3s","mode":"backfill","month":"MM"}` (twelve invocations,
  each marking that month wanted for every system), into
  `c3s-hc/<system>/<MM>/tp_mm` (year, member, lead day, lat, lon), the
  years held recorded. `c3s/index.json` lists what is held.
- **Limits we keep to:** at most one request per system and init (or
  hindcast month) and 4 queued in all; one API call a second; a failed
  request backs off 1–16 days and stops after 5 (`RequestsFailed`); a
  401/403 stops the run for the UTC day; never waits inside a Lambda.
- **Fallback:** none upstream; without a copy the outlook stays ESP (the
  default), as #620 says.
- **Owner:** the operator; code `ingest/c3s_seasonal.py`,
  `ingest/c3srequest.py`, `infra/c3s.tf`. Freshness alarm
  `mirror-lag-c3s` (MirrorLagDays{Product=c3s}: days since the 1st of the
  newest init every system is held for, past `c3s_lag_alarm_days`, 45).
- **Fixtures:** invented values written on the fly by
  `ingest/fixtures/c3s/make_c3s_fixture.py` (GRIB2 in the CDS's layout: a
  few members, any lead count, three hindcast years), served by
  `ingest/fakecds.py` `FakeC3sCds` under `FEED_SOURCE=fixtures`.

## Future climate

An evidence pack's Future yield section and the Scenarios tab's future
climate (issue #621) rerun the record under monthly change factors from
downscaled climate projections ([model.md §2.17](./model.md#217-future-climate-monthly-change-factors-engine-11070-issue-621)).
The factors come from our own copy: monthly aggregates of one archive,
loaded once.

### nex-gddp-cmip6

- **Source:** NASA Earth Exchange Global Daily Downscaled Projections,
  CMIP6 (NEX-GDDP-CMIP6), NASA Ames Research Center's NEX: daily `pr`,
  `tasmax` and `tasmin` from CMIP6 models, bias-corrected and spatially
  disaggregated (BCSD) against the GMFD observations onto a 0.25° grid, for
  the `historical` run (to 2014) and the four Tier-1 SSPs (to 2100). We
  take `historical`, `ssp245` and `ssp585` only. The archive is static: no
  further updates are planned, so this is a **one-off load**, nothing
  scheduled (issue #621 § Design).
- **Host:** `s3://nex-gddp-cmip6` (AWS Open Data, **us-west-2**, anonymous
  read; the bucket's NetCDF files, one per model, scenario, variable and
  year, with a version suffix on revised files). The load runs once, in
  us-west-2 (CloudShell or a temporary Lambda, the operator's go-ahead
  first; issue #621 open question 1), and writes only the region's monthly
  aggregates to our copy in af-south-1.
- **Licence:** **CC0** ("since September 2022 every output is under a
  blanket CC0", the AWS Registry of Open Data entry for NEX-GDDP-CMIP6,
  read 2026-10-27). The archive was first released under **CC BY-SA 4.0**,
  and the Scientific Data paper and some mirrors still say so; share-alike
  on our output would fail D-B, CC0 passes it. Because the files' own
  metadata may predate the change, the ingest records each file's global
  `license` attribute in the manifest, so a file still marked CC BY-SA is
  visible (and is the operator's to decide on, not loaded silently).
- **Attribution:** none is required under CC0; we credit anyway, wherever
  the factors show (the scenario's source line, an evidence pack's § 8,
  the Data sources and credits page): "Climate projections: NASA Earth
  Exchange Global Daily Downscaled Projections (NEX-GDDP-CMIP6), NASA Ames
  Research Center, from the CMIP6 models of the modelling groups listed,
  downscaled by NASA NEX. We thank the climate modelling groups of the
  World Climate Research Programme's CMIP6 for producing and making
  available their model output." with the models used and their groups.
  The engine's credit text lands with slice 4.
- **The caveat (owed before slice 4):** NASA's technical note asks for
  expert input before the projections are used for engineering (the #604
  research read it in `NEX-GDDP-CMIP6-Tech_Note_4.pdf`). **That URL returns
  404 today** (2026-10-27), so the caveat is **not yet quoted**. Before §
  8 *Future yield* ships, the current tech note is found and its caveat
  quoted here verbatim, with its URL and the date read; § 8 opens with
  those words.
- **The model list (frozen; provisional, pending the hydrologist):** ten
  models, one per modelling centre so the range isn't one centre's model
  counted twice, each needing `pr`, `tasmax` and `tasmin` for
  `historical`, `ssp245` and `ssp585` (the load checks the bucket's listing
  for every file before it starts, and stops on a gap rather than drop a
  model):

  | Model | Group | Variant |
  | --- | --- | --- |
  | ACCESS-CM2 | CSIRO-ARCCSS (Australia) | r1i1p1f1 |
  | CNRM-CM6-1 | CNRM-CERFACS (France) | r1i1p1f2 |
  | EC-Earth3 | EC-Earth consortium (Europe) | r1i1p1f1 |
  | GFDL-ESM4 | NOAA GFDL (USA) | r1i1p1f1 |
  | INM-CM5-0 | INM (Russia) | r1i1p1f1 |
  | IPSL-CM6A-LR | IPSL (France) | r1i1p1f1 |
  | MIROC6 | MIROC (Japan) | r1i1p1f1 |
  | MPI-ESM1-2-HR | MPI-M and DWD (Germany) | r1i1p1f1 |
  | MRI-ESM2-0 | MRI (Japan) | r1i1p1f1 |
  | NorESM2-MM | NCC (Norway) | r1i1p1f1 |

  Why these (issue #621 open question 2): the issue asks for about ten
  models with all three variables for both SSPs and good skill for
  southern Africa's winter rainfall (the frontal rain of the Western
  Cape, which the client catchments get). Independence first: one model
  per centre. The skill screen itself (how well each model's historical
  run gives the winter rainfall's seasonal cycle and its interannual
  variability over the region) is **the hydrologist's to confirm** against
  the regional CMIP6 evaluations before the list is used for a pack; a
  model may be swapped for another of the same centre or another centre
  then, and this table changes with it (the factors' manifest names the
  list in force). Each SSP, horizon and section shows the range across
  the models, never one number (§ 8 needs at least 5).
- **Contact:** NASA NEX (the registry entry's contact); the AWS Open Data
  team for the bucket.
- **Access pattern:** a one-off read, in us-west-2, of the three variables'
  daily files for the ten models (1985–2014 historical; 2036–2065 and
  2066–2095 for each SSP), each cut to region D1 by its chunking or ranges,
  never whole global files downloaded to af-south-1. Kept: **monthly
  aggregates only** (the month's `pr` total in mm, the means of `tasmax`
  and `tasmin`; the factor code takes them in °C) per model, SSP and year, as Zarr
  `cmip6/<model>/<ssp>`, with each source file's name, version suffix,
  `license` attribute and our hash of the values kept in the manifest
  (slice 2).
- **Limits we keep to:** one pass; at most 2 requests in flight; no
  daily values kept; the ranges of each file read once.
- **Fallback:** none needed upstream (static); our copy is the record.
  Without it the Future yield section and the picker stay off
  (`FUTURE_YIELD=off`, the default).
- **Owner:** the operator (the load's go-ahead); code `ingest/cmip6_delta.py`
  (slice 2) and `packages/engine/src/scenario/climate.ts` (the factors,
  from the aggregates: ratios of the area-weighted means over the 0.25°
  cells, Hargreaves–Samani PET from the temperatures, clamped to 0.5–1.5).
- **Fixtures:** synthetic monthly aggregates for invented models `SYN-A`
  to `SYN-C` (`ingest/fixtures/cmip6/`, `backend/fixtures/mirror/cmip6/`,
  slice 2); dev, CI and e2e never read the bucket.

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
| GloFAS v4 reanalysis | CEMS-FLOODS, free with attribution | EWDS API | modelled daily flow for ungauged catchments |
| SWOT lake heights (Sentinel-1/2 and WaPOR moved to the register for #624 and #623) | SWOT terms unconfirmed | PO.DAAC | area–volume curves (trial) |

## Rejected

| Source | Why not |
| --- | --- |
| Google Earth Engine | Free tiers are non-commercial; commercial use from $500/month; data would cross clouds |
| MSWEP | CC BY-NC 4.0 unless bought through GloH2O's API |
| TAMSAT, ARC2, PERSIANN, PDIR-Now as a CHIRPS fallback | Infrared-only: the same blind spot in winter frontal and orographic rain |
| HWSD, the Global Aridity Index, GMIA, the SA Fields of the World labels | Non-commercial licences |
| MERIT Hydro, FAO WaPOR v3 reference ET, DWS 1:500 000 rivers, the Lynch (2004) MAP grid | Fail D-B or unconfirmed: [maps.md § Sources](./maps.md#sources) |
| Reading CHC live, only slower | Bans are per address and by volume; a 16,000-file backfill per feed can't be made polite |
