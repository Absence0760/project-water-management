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
| [dws-flow](#dws-flow) | DWS verified daily flow | live; the weekly job and the written request in R3-B | `www.dws.gov.za` | `dws` | `backend/src/feeds/sources/dws.ts`; R3 `backend/src/ingest/dws.ts` |
| [dynamical](#dynamical) | dynamical.org's copy of CHIRPS v3 | planned R3-E (verification only) | `s3://dynamical-ucsb-chc-chirps` (us-west-2) | – | R3 `ingest/verify_copy.py` |
| [dpet](#dpet) | dPET daily potential evapotranspiration | reference load | `data.bris.ac.uk` | – | `bin/evaporation-fetch.sh`, `pnpm import:evaporation` |
| [worldcover](#worldcover) | ESA WorldCover 10 m 2021 v200 (cropland) | reference load | `esa-worldcover.org` (the operator's download) | – | `pnpm import:land-cover` |
| [hydrorivers](#hydrorivers) | HydroRIVERS v1.0 | reference load | `data.hydrosheds.org` | – | `bin/tiles-dev.sh` (`dev:tiles:rivers`), `pnpm import:rivers` |
| [geonames](#geonames) | GeoNames gazetteer (ZA and neighbours) | reference load | `download.geonames.org` | – | `pnpm import:gazetteer` |
| [jrc-gsw](#jrc-gsw) | JRC Global Surface Water v1.5 occurrence | reference load (tiles) | `s3.waw4-1.cloudferro.com` | – | `bin/tiles-dev.sh` (`dev:tiles:water`), `tiles-upload.ts` |
| [dem](#dem) | Copernicus GLO-30 DEM, Mapterhorn's Terrarium tiles | reference load (tiles) | `download.mapterhorn.com` | – | `bin/tiles-dev.sh` (`dev:tiles:terrain`), `tiles-upload.ts` |
| [basemap](#basemap) | Protomaps basemap (OpenStreetMap) and its label fonts | reference load (tiles) | `build.protomaps.com`, `codeload.github.com` | – | `bin/tiles-dev.sh` (`dev:tiles:fetch`, `dev:tiles:fonts`), `tiles-upload.ts` |
| [waas-map](#waas-map) | WAAS Southwestern Cape MAP grid | reference load | none (a copy from the client) | – | `pnpm import:map-grid` |
| [quaternaries](#quaternaries) | Quaternary outlines and WR2012 values | blocked | `www.dws.gov.za`, WRC (the operator's download) | – | `pnpm import:quaternaries` |
| [dam-register](#dam-register) | DWS List of Registered Dams and its overlay | blocked | `www.dws.gov.za` | – | `pnpm import:dam-register` |
| [gauge-stations](#gauge-stations) | DWS hydrological station catalogue | blocked | `www.dws.gov.za` | – | `pnpm import:gauge-stations` |
| [era5-land](#era5-land) | ERA5-Land daily precipitation | planned R4-A | `cds.climate.copernicus.eu`, `s3://nsf-ncar-era5` (backfill) | – | R4 `ingest/era5land.py` |
| [ecmwf-ens](#ecmwf-ens) | ECMWF open data ENS / AIFS-ENS precipitation | planned R4-C | `s3://ecmwf-forecasts` (eu-central-1) | `ecmwf_ens` (planned) | R4 `ingest/ecmwf.py` |
| [imerg](#imerg) | IMERG Late V07 daily (GSMaP Gauge-NRT second) | planned R4-D | NASA GES DISC (Earthdata) | – | R4 `ingest/imerg.py` |
| [deafrica-waterbodies](#deafrica-waterbodies) | DE Africa Waterbodies area series | planned R5-A | `s3://deafrica-services` (af-south-1) | – | R5 |
| [deafrica-wofs](#deafrica-wofs) | DE Africa WOfS inside our own outlines | planned R5-C | `s3://deafrica-services`, `explorer.digitalearth.africa` | – | R5 |
| [sanlc](#sanlc) | SANLC orchard and vine classes | planned R5-D (gated on its terms; blocked today) | `egis.environment.gov.za` | – | R5 |
| [agera5](#agera5) | AgERA5 daily reference ET (NASA POWER fallback) | planned R5-E | `cds.climate.copernicus.eu`; `power.larc.nasa.gov` | – | R5 |

## Live feeds

Common to all three today (`backend/src/feeds/http.ts`, the fetcher Lambda
in `infra/feeds.tf`):

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
- **Access pattern planned (R1–R3):** one ingest job for the whole region
  (D1: 10–41°E, 35.5–8°S), into Zarr `rnl`, `sat` and `prelim` with a
  `manifest.json` each:
  - finals: one `byMonth` NetCDF listing per product around the 20th–25th,
    then the new or changed month's file, whole (about 330 MiB);
  - backfill: about 550 `byMonth` files for `rnl` (316 for `sat`), one a
    minute;
  - preliminary `sat`: only new files, as the strip-offset table plus one
    range over the region's rows, about 3 requests a file.
- **Limits we keep to:** at most 1–2 requests in flight and about 1 a
  second (dynamical.org settled on the same against CHC); about 50–60
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
- **Licence:** **unconfirmed.** DWS publishes no API and no terms for these
  pages; its NIWIS wording elsewhere says data "may not be sold to third
  parties" and is "restricted to use for academic, research or personal
  purposes" ([maps.md § Sources](./maps.md#sources); followups.md, Terms of
  use). The written request below asks for permission to store the data and
  show derived results in a commercial tool.
- **Attribution:** "Department of Water and Sanitation" as the copyright
  owner, if allowed.
- **Contact:** DWS National Hydrological Services, GeoRequests@dws.gov.za
  (Hydstra data). Letter not yet sent (#604 operator steps).
- **Access pattern today:** each DWS feed asks for a 2-year window
  (`DWS_WINDOW_DAYS`, 365-day re-read) per station; the site allows 20 years
  a request.
- **Access pattern planned (R3-B, D14):** the written data request is the
  primary route, loaded by an operator import (`pnpm import:dws`) into a
  `gauge_record` table; a **weekly** top-up job asks only for stations some
  feed uses, the newest 2-year window each.
- **Limits we keep to:** 1 request a second; a 403 or the ScriptServer page
  marks the source stale and alerts, never retries.
- **Fallback:** the manual DWS import, already built
  (`frontend/src/lib/series/dws.ts`, sharing the engine's parser,
  `@water-management/engine/dws`).
- **Owner:** the operator; code `backend/src/feeds/sources/dws.ts`, then
  R3-B `backend/src/ingest/dws.ts`.

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
`reference_load` the key and SHA-256 of a production load; tiles record
nothing in the database yet (R3-D). Download checksums are pinned in
`bin/source-checksums.sha256` ([maps.md § Checksums](./maps.md#checksums)).
The full licence readings are in [maps.md § Sources](./maps.md#sources).
Refresh is yearly at most; the fallback for each is the original file kept
in the reference bucket.

| Id | Licence (read) | Attribution | Contact | Access pattern | Limits we keep to | Fallback | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <a id="dpet"></a>dpet | CC BY 4.0 (data.bris, read 2026-10-02); contains modified Copernicus (ERA5-Land) information | "hPET/dPET © Singer et al. 2021, University of Bristol, CC BY 4.0. Contains modified Copernicus Climate Change Service information (ERA5-Land, CC BY 4.0); neither the European Commission nor ECMWF is responsible for any use of it." | the data.bris dataset page | yearly files, ~2.4 GB each, downloaded whole, reduced, then deleted (`pnpm import:evaporation:fetch`) | one file at a time; SHA-256 recorded on first fetch and checked after | the reduced grid in the reference bucket; the synthetic grid locally | operator; `bin/evaporation-fetch.sh` |
| <a id="worldcover"></a>worldcover | CC BY 4.0 (esa-worldcover.org and Zenodo 10.5281/zenodo.7254221, read 2026-10-01) | "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium"; in reports, Zanaga, D. et al. (2022) | esa-worldcover.org | the operator's tiles, pre-summarised into cells at import | a handful of tiles, once | the summarised grid in the reference bucket | operator; `pnpm import:land-cover` |
| <a id="hydrorivers"></a>hydrorivers | HydroSHEDS v1 licence: free for commercial use, incorporated into derivative works only (TechDoc v1.0 § 4.1, read 2026-10-01) | Exhibit B's statement, on `/data-sources#hydrorivers`; cite Lehner & Grill (2013) | hydrosheds.org | one zip (`HydroRIVERS_v10_af_shp.zip`), whole | one request; SHA-256 pinned | the zip in the reference bucket | operator; `bin/tiles-dev.sh` |
| <a id="geonames"></a>geonames | CC BY 4.0 (the dump's `readme.txt`, read 2026-10-13) | "GeoNames (geonames.org), CC BY 4.0" | geonames.org | seven country dumps (ZA, BW, LS, MZ, NA, SZ, ZW), whole | seven requests a refresh | the dumps in the reference bucket | operator; `pnpm import:gazetteer` |
| <a id="jrc-gsw"></a>jrc-gsw | Copernicus free, full and open; "provided free of charge, without restriction of use" (download page, read 2026-10-02) | "Source: EC JRC/Google"; cite Pekel et al. (2016) | the JRC GSW download page | the six occurrence tiles over `TILES_BBOX`, whole | six requests; SHA-256 pinned | the PMTiles in the tiles bucket | operator; `bin/tiles-dev.sh` |
| <a id="dem"></a>dem | Copernicus WorldDEM-30 licence, commercial use allowed (read 2026-10-01); tiles by Mapterhorn (code BSD-3) | the Art. 6(b) notice and "© Mapterhorn" while the relief is drawn; Art. 6(c) on `/data-sources` | mapterhorn.com | `pmtiles extract` of the region's byte ranges from the planet archive | one extract a refresh; ETag-consistent reads | the PMTiles in the tiles bucket | operator; `bin/tiles-dev.sh` |
| <a id="basemap"></a>basemap | ODbL 1.0 for the OpenStreetMap data (openstreetmap.org/copyright, read 2026-10-01); label fonts SIL OFL 1.1 | "© Protomaps © OpenStreetMap contributors", always on the map; the OFL notice beside the glyphs | protomaps.com; OpenStreetMap Foundation | `pmtiles extract` of one daily build (`TILES_BUILD`) for the region; fonts as one archive of a pinned commit (`FONTS_REF`) | one extract and one archive a refresh | the PMTiles and fonts in the tiles bucket | operator; `bin/tiles-dev.sh` |
| <a id="waas-map"></a>waas-map | terms not stated; the operator's decision (2026-10-23) to use it, [legal/map-data-licences.md § 3.3b](./legal/map-data-licences.md#33b-the-southwestern-cape-map-surface-waas-the-operators-decision-added-2026-10-23) | "Mean annual rainfall surface for the Southwestern Cape. Prepared for the WAAS project by Beuster Clarke & Associates. March 2007, Version 1.1." | the client | a file from the client; no download | none fetched | the file in the reference bucket | operator; `pnpm import:map-grid` |
| <a id="quaternaries"></a>quaternaries | **blocked:** DWS outlines' commercial terms unconfirmed; WR2012 redistribution terms unpublished | DWS; WR2012 (WRC 2015) | DWS; WRC | the operator's download, loaded into the operator's own database only | – | the synthetic fixture everywhere else | operator; `pnpm import:quaternaries` |
| <a id="dam-register"></a>dam-register | **blocked:** no terms on the DSO page; DWS's general terms are non-commercial | "Department of Water and Sanitation" | DWS Dam Safety Office | the operator's XLS and KMZ download | – | the synthetic list | operator; `pnpm import:dam-register` |
| <a id="gauge-stations"></a>gauge-stations | **blocked:** unconfirmed (the Verified pages answer 403 outside South Africa) | "Department of Water and Sanitation" | GeoRequests@dws.gov.za | the operator's catalogue download | – | the synthetic stations | operator; `pnpm import:gauge-stations` |

## Planned sources

From #604's Rounds 4 and 5. Each gets its full section here when its round
starts.

| Id | Licence | Attribution | Contact | Access pattern | Limits we keep to | Fallback | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| <a id="era5-land"></a>era5-land | CC BY 4.0 (Copernicus, since 2025-07-02) | Copernicus's attribution text wherever its values show (UI, reports, exports) | ECMWF support (CDS); needs a CDS account and API key (operator step) | CDS API with area subsetting, monthly into Zarr `era5l` (0.1°); a request is submitted on one run and collected on a later one (queues of hours) | one request in flight; never waits inside a Lambda | AWS `nsf-ncar-era5` for backfill (3–4 months behind) | operator; R4-A |
| <a id="ecmwf-ens"></a>ecmwf-ens | CC BY 4.0 (ECMWF open data) | ECMWF, CC BY 4.0 | ECMWF support | `tp` for the region from each 00 UTC ENS/AIFS-ENS run, anonymous S3, archived as `ecmwf/<issue>` (ECMWF keeps only ~12 runs) | one run a day; subset at the source before copying to af-south-1 | CHIRPS-GEFS | operator; R4-C |
| <a id="imerg"></a>imerg | CC BY 4.0 | NASA GPM IMERG, with its version | NASA GES DISC / Earthdata forum; needs an Earthdata login and token (operator step) | `GPM_3IMERGDL` daily, region subset, product `imerg_late`, only days with no CHIRPS preliminary value | Earthdata allows about 20–60 requests a minute; we keep to 1 a second | GSMaP Gauge-NRT (commercial use allowed with credit; FTP after registration) | operator; R4-D |
| <a id="deafrica-waterbodies"></a>deafrica-waterbodies | CC BY 4.0 | Digital Earth Africa | Digital Earth Africa | weekly read of the Waterbodies area series for our traced dams into `dam_observation`; same region as the app, unsigned | weekly; only the waterbodies our dams overlap | [deafrica-wofs](#deafrica-wofs) | operator; R5-A |
| <a id="deafrica-wofs"></a>deafrica-wofs | CC BY 4.0 | Digital Earth Africa | Digital Earth Africa | WOfS scenes from the STAC catalogue, summed inside our own dam outlines | only scenes over our dams | none (Sentinel-1/2 masks are a Round 6 candidate) | operator; R5-C |
| <a id="sanlc"></a>sanlc | **gated:** fails D-B on the terms we could read (2013/14: no derivatives, no competing products); the 2018–2022 terms on EGIS still to be read (operator step) | "© GEOTERRAIMAGE" with the year, if allowed | DFFE (EGIS) | the operator's download, once allowed | – | WorldCover | operator; R5-D |
| <a id="agera5"></a>agera5 | CC BY (Copernicus); NASA POWER: no restrictions, CC BY 4.0 on AWS | Copernicus; NASA POWER | ECMWF support; NASA POWER | CDS API, daily FAO-56 reference ET for the region | as era5-land | NASA POWER (REST, usage monitored, or S3) | operator; R5-E |

## Candidates for Round 6 and later

Each becomes its own issue once Rounds 1–3 land, and gets a row in the
register before any code fetches it (#604 § Round 6 and later; research in
its comments 4, 6, 7 and 8).

| Source | Licence | Access | Use |
| --- | --- | --- | --- |
| C3S multi-system seasonal | CC BY, plus the additional licence for non-European contributions | CDS API, 1° monthly | seasonal outlook per restriction level |
| ENSO / SAM indices | NOAA public; cite Marshall | NOAA PSL ASCII | analogue-year outlook |
| NEX-GDDP-CMIP6 | CC0 (NASA's expert-use caveat) | S3 us-west-2 | future yield in evidence packs |
| iSDAsoil, SoilGrids 2.0, HydroATLAS, GRDC-Caravan | CC BY 4.0 (SoilGrids' REST allows 5 calls a minute) | S3 us-west-2; WCS; downloads; Zenodo | GR4J priors for ungauged units |
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
