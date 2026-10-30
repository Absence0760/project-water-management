# Bulk ingest job

The scheduled job that copies upstream rain data into **our own copy**, so the
app never fetches from someone else's server because a feed or a user asked
(issue #604, "The rule"). Python 3.14, run as an arm64 container-image Lambda
(D11), since NetCDF/HDF5 has no good Node reader. The daily TIFF and DWS
ingest stay in Node (`backend/`).

Round 1 built the skeleton (the writer, the manifest, the polite client, the
image and CI); Round 2 (R2-A) added the CHIRPS finals job, `chirps_final.py`,
which lists CHC's `byMonth` directories and copies new or rewritten months.
Fixtures mode runs the same code against a synthetic directory. Round 4
(R4-A) added ERA5-Land, `era5land.py` (product `era5l`, § The ERA5-Land
job), whose CDS requests are submitted on one run and collected on a later
one. Round 5 (R5-E) added daily reference evaporation: AgERA5's FAO-56 ET₀
(`agera5.py`, product `agera5_et0`, the same CDS machinery, now shared in
`cdsjob.py`) and its fallback, NASA POWER's daily meteorology turned into
FAO-56 ET₀ by us (`nasapower.py` + `fao56.py`, product `power_et0`; § Reference
evaporation). Issue #620 added C3S's seasonal forecasts and hindcasts
(`c3s_seasonal.py`, products `c3s/<init>` and `c3s-hc/<system>/<MM>` on a
1° grid, the same CDS submit-then-collect rules; § The C3S seasonal job).
Issue #621 added a one-off, operator-run copy of NEX-GDDP-CMIP6's monthly
aggregates for the future yield (`cmip6_delta.py`, products
`cmip6/<model>/<scenario>` on a 0.25° grid; § NEX-GDDP-CMIP6, once), which is
not in the image and never scheduled.

| File | What it does |
| --- | --- |
| `lambda_handler.py` | `handler(event, context)`: validates the event, runs the finals job, and publishes `MirrorLagDays` on every exit. |
| `chirps_final.py` | The CHIRPS finals job (below): the listing and its diff, paced whole-file downloads within the time budget, and `ingest_file`, the single-file path. |
| `era5land.py` | The ERA5-Land job (§ The ERA5-Land job): submit a month's CDS request, collect it on a later run, the 0.1° remap, the revision rule, and its own handler (`lambda_handler.py` hands `era5l` events to it). |
| `cdsjob.py` | The CDS submit-then-collect machinery `era5land.py` and `agera5.py` share: the request state, the intent before a submit, adopting a queued request, backoff and the give-up rule, the refusal marker, the lease, `LiveCds` and the handler that publishes the lag on every exit. Each product brings a `CdsProduct` spec. |
| `era5request.py`, `agera5request.py` | Each CDS product's request (dataset, a month's request, the month a request names), shared by its job and `fakecds.py` so the fake never imports the job that imports it; `CdsError` and `CDS_URL` are `cdsjob.py`'s. |
| `fakecds.py` | Fixtures mode's stand-in for the CDS: submit, status, find and download, serving `fixtures/era5land/`'s synthetic NetCDF (`FakeCds`), `fixtures/agera5/`'s synthetic zip (`FakeAgera5Cds`) and `fixtures/c3s/`'s synthetic GRIB (`FakeC3sCds`), checking each request against the request modules. Not in the image. |
| `agera5.py` | AgERA5's daily FAO-56 reference ET into `agera5_et0` (§ Reference evaporation): the month request, the reader (a zip of daily NetCDFs or one NetCDF, cells placed by coordinate), the 0–30 mm check, the revision rule; its runs are `cdsjob.py`'s. |
| `c3s_seasonal.py` | C3S's seasonal forecasts and hindcasts into `c3s/<init>` and `c3s-hc/<system>/<MM>` (§ The C3S seasonal job): per-system requests keyed by init, submit on one run and collect on a later one (cdsjob.py's rules and pieces), the GRIB reader and de-accumulation, the group arrays, the manifests, `c3s/index.json` and its own handler. |
| `cmip6_delta.py` | NEX-GDDP-CMIP6's monthly aggregates into `cmip6/<model>/<scenario>` (§ NEX-GDDP-CMIP6, once): `plan` (what the bucket lists, the highest version of each file, what is missing) and `copy` (ranged reads of each daily file, D1 placed by coordinate, monthly totals and means, the checks, the manifest with each file's version and `license` attribute, `cmip6/index.json`, resumable). Operator-run once; not in the image. |
| `fixtures/cmip6/make_cmip6_fixture.py` | Writes the synthetic NEX-GDDP-CMIP6 tree (models `SYN-A`, `SYN-B`, `SYN-C`, two years a scenario, one calendar each, a re-released file, a missing day, an old and a missing `license`) for `cmip6_delta.py --source fixtures` and the tests. Nothing committed but the script. |
| `c3srequest.py` | C3S's request module: the dataset, `SYSTEMS`, the centres' names, the release days, a key's request and the key a request names; shared with `fakecds.py`. |
| `fixtures/c3s/make_c3s_fixture.py` | Writes a synthetic C3S request's GRIB2 (accumulated `tp` per start, member and lead on the 1° grid; any member and lead count, a hindcast's years); `fakecds.py` calls it for each download. |
| `fixtures/agera5/make_agera5_fixture.py` | Writes a synthetic AgERA5 month (a zip of daily NetCDF-4 files, or one file; x.x5 cells, or x.x0 points); `fakecds.py` calls it for each download. |
| `nasapower.py` | The fallback, `power_et0` (§ Reference evaporation): NASA POWER's daily regional API, one parameter a request over 12 tiles, FAO-56 ET₀ per POWER point, the nearest point for each 0.1° cell, the last N days re-read each run, 120 days kept. |
| `fao56.py` | FAO-56 Penman-Monteith ET₀, daily (eq. 6 with eqs. 7–40), from Tmax, Tmin, Tdew, u2, Rs and P. Tested against FAO-56's worked examples. |
| `power_fixture.py` | Fixtures mode's fake NASA POWER: regional JSON answers in POWER's shape with synthetic meteorology. Not in the image. |
| `penpan.py` | PenPan, a modelled US Class-A pan (Rotstayn et al. 2006; McMahon et al. 2013 S6, eqs. S6.1–S6.6), monthly steady state, stdlib only (§ A modelled Class-A pan). Not in the image. |
| `apan_grid.py` | The operator's modelled Class-A pan grid: `fetch` (POWER's daily weather to monthly means, a year a file), `grid` (PenPan's normal on 0.1° cells, the `apan` form) and `validate` (against station pans, a Markdown report). Not in the image. |
| `requirements.a.in` | R4-A's direct dependency (`ecmwf-datastores-client`, the CDS client), to be hash-pinned into `requirements.txt` at the round's merge. |
| `cloudwatch.py` | The freshness metric `MirrorLagDays` (CloudWatch live, a local sink in fixtures mode). |
| `lease.py` | One writer per product: a lease object taken with S3 conditional writes. Also CHC's one request slot, shared with the fetcher Lambda (`hold_host`). |
| `fixturehttp.py` | Fixtures mode's stand-in for CHC's server over `fixtures/chirps/`. Not in the image. |
| `polite.py` | The one HTTP client (below). |
| `zarrstore.py` | The Zarr v3 writer for both D2 layouts, against a local directory or S3. |
| `manifest.py` | `<product>/manifest.json`: read, write, validate, and `valuesSha256`. |
| `chcnetcdf.py` | Reads one CHC NetCDF file and cuts out the region (D1), refusing any other layout. |
| `grid.py` | The region, the grid and the index maths every module shares. |
| `backfill_plan.py` | Prints the backfill state machine's month list (`infra/ingest_backfill.tf`), skipping months the manifest holds. Standard library only. Runbook: docs/deployment.md § Backfill. |
| `verify_copy.py` | The operator's check of a backfilled copy before the cutover: coverage, CHC's daily files bit for bit, dynamical.org's copy within 0.2% (§ Verify the copy). Not in the image. |
| `tiffread.py` | A stdlib GeoTIFF strip reader: one pixel of a CHC daily file through range requests, for `verify_copy.py`. Not in the image. |
| `requirements-verify.txt` | `verify_copy.py`'s hash-pinned packages (the image's plus icechunk), for `ingest/.venv-verify` only. |
| `fixtures/make_chc_fixture.py` | Writes `fixtures/chc/chirps-v3.0.2024.02.days_p05.nc`, the reader's synthetic fixture. |
| `fixtures/era5land/make_era5land_fixture.py` | Writes a synthetic ERA5-Land month in the CDS's NetCDF layout; `fakecds.py` calls it for each download, so nothing binary is committed. |
| `ecmwf_forecast.py` | The ECMWF ENS forecast job (below): index-based range reads of `tp`, decoding with eccodes, the region on the 0.1° grid, daily totals, the ensemble statistics, `ecmwf/<issue>` and its index, resumed across runs. |
| `ecmwf_qm_fit.py` | The operator's offline quantile-mapping fit of the ECMWF forecast to our rain; writes `ecmwf/qm.json`. Not in the image. |
| `ecmwf_fixturehttp.py` | Fixtures mode's stand-in for ECMWF's open data bucket over `fixtures/ecmwf/`, re-dated to any issue. Not in the image. |
| `fixtures/ecmwf/make_ecmwf_fixtures.py` | Writes the synthetic ECMWF step files (`fixtures/ecmwf/`: 15 GRIB2 files and their `.index`), and builds the tests' structured ones. |
| `fixtures/chirps/make_chirps_fixtures.py` | Writes the synthetic `byMonth` directory (`fixtures/chirps/`): two months, their listing, and a rewritten and a changed variant. |
| `imerg.py` | IMERG Late's recent days into `imerg_late` (§ IMERG Late): the CMR search, the OPeNDAP region subset, the reader that places cells by coordinate, the per-day version, the refusal marker and the Earthdata token. |
| `earthdata.py` | The Earthdata secret as a bare token or a stored login; with a login, a token from Earthdata Login's user token API (list, create, revoke at the 2-token limit), its days left (`EarthdataTokenDaysLeft`). |
| `imerg_fixture.py` | Fixtures mode's fake CMR and OPeNDAP: UMM-G search results and NetCDF-4 subsets cut from `fixtures/imerg/`'s synthetic field. Not in the image. |
| `fixtures/imerg/make_imerg_fixture.py` | The synthetic IMERG Late daily field and file writer, in GPM_3IMERGDL V07's real layout (a global file from the command line). |
| `tests/roundtrip.ts` | The Node half of the cross-language round trip (`test_roundtrip.py`). |
| `Dockerfile` | The Lambda image (build context `ingest/`). |
| `dev.sh` | `pnpm dev:ingest:run`, `pnpm test:ingest`, `ingest/dev.sh verify` and `ingest/dev.sh cmip6`. |

## The event and the environment

```json
{ "product": "rnl" | "sat", "mode": "monthly" }
{ "product": "rnl" | "sat", "mode": "backfill", "month": "YYYY-MM" }
{ "product": "rnl" | "sat", "mode": "backfill", "month": "YYYY-MM", "hold": { "execution": "<execution id>", "pauseSeconds": 60 } }
{ "mode": "release_hold", "hold": { "execution": "<execution id>" } }
{ "product": "imerg_late", "mode": "recent", "days": 10 }
{ "product": "ecmwf", "mode": "daily" }
```

`hold` and `release_hold` are the backfill state machine's (§ One process
asking CHC at a time, below).

A backfill names its month (from 1981-01 for `rnl`, 2000-06 for `sat`); a
monthly run takes none. An `imerg_late` event takes an optional `days`
(1–30, default 10; § IMERG Late). Any other key is refused.
{ "product": "era5l", "mode": "monthly" }
{ "product": "era5l", "mode": "backfill", "month": "YYYY-MM" }
{ "product": "agera5_et0", "mode": "monthly" }
{ "product": "agera5_et0", "mode": "backfill", "month": "YYYY-MM" }
{ "product": "power_et0", "mode": "recent", "days": 30 }
{ "product": "c3s", "mode": "monthly" }
{ "product": "c3s", "mode": "backfill", "month": "MM", "system": "ecmwf-51" }
```

A backfill names its month (from 1981-01 for `rnl`, 2000-06 for `sat`); a
monthly run takes none. Any other key is refused. An `era5l` backfill
names a month from 1950-01 to the newest complete one, an `agera5_et0`
backfill one from 1979-01. A `power_et0` event takes an optional `days`
(1–60, default 30). A `c3s` backfill names a hindcast init month
(`"01"`–`"12"`) and, optionally, one system of `c3srequest.SYSTEMS`.

| Variable | Meaning |
| --- | --- |
| `MIRROR_URL` | Required. `file:///abs/path` locally, `s3://<bucket>[/prefix]` in production. |
| `FEED_SOURCE` | `fixtures` (the default: the synthetic `byMonth` directory, no network) or `live` (production: CHC). |
| `INGEST_CONTACT` | The contact address in the User-Agent. Optional. |
| `INGEST_FIXTURE_VARIANT` | Fixtures mode only: `rewritten` or `changed` serves that variant of the synthetic directory. |
| `EARTHDATA_TOKEN_SECRET_ARN` | Live mode, `imerg_late` only: the Secrets Manager secret holding the Earthdata token or login (`infra/imerg.tf`, § IMERG Late). Read at run time, never logged or written back; fixtures mode reads nothing. |
| `CDS_KEY_SECRET_ARN` | Live `era5l`, `agera5_et0` and `c3s` runs only: the Secrets Manager secret holding the CDS API key (`infra/era5land.tf`; one Copernicus account, one key, for both), read at run time and never logged. Fixtures mode never reads it. `power_et0` needs no key. |
| `MIRROR_METRIC_NAMESPACE` | Optional: the metric's namespace, default `water-management/Mirror`. |

Fixtures mode runs exactly the live code with three differences: CHC is
`fixturehttp.FixtureOpener`, nothing is paced (there is no upstream to be
polite to), and the metric goes to a local sink that logs it.

## The CHIRPS finals job

CHC publishes each month's finals as one NetCDF per product:
`https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/<rnl|sat>/netcdf/byMonth/chirps-v3.0.YYYY.MM.days_p05.nc`
(`rnl` from 1981-01, `sat` from 2000-06), listed on an nginx autoindex page
with each file's time (UTC, to the minute) and size.

**`monthly`** runs daily per product (EventBridge, `infra/ingest.tf`):

1. One conditional GET of the listing, with the validators the last complete
   run saved. A 304 ends the run. (If CHC's autoindex sends no ETag or
   Last-Modified, the run reads the whole page: still one request.)
2. The listing is diffed against the manifest's `files`. A month the manifest
   lacks is new. A month whose size or time differs from the manifest's
   `size` or `lastModified` is changed: CHC rewrites files in place.
3. Each new or changed month is downloaded whole, oldest first, one at a
   time. Downloads start at least **a minute apart** (D4), counting across
   runs: the last download's time is kept in `ingest-state/<product>/state.json`.
   No download starts with less than 360 s of the Lambda's time left
   (`context.get_remaining_time_in_millis()`); the rest wait for the next day.
   The listing's validators are saved only when nothing was left, so a run cut
   short never becomes a 304 that hides the rest.
4. Each file is checked against its listing row (size, and its Last-Modified
   to the minute; a mismatch stops the run, since it means the page and the
   files disagree, for example a listing in another time zone). Then
   `ingest_file` subsets it, checks 0–2000 mm, hashes, writes and records it
   (below). The revision goes up only on a real change of values.

**`backfill`** copies one named month the same way, with one conditional GET
of its file and no listing (a month already held, unchanged, is a 304).
R2-B's Step Functions map calls it one month per invocation.

**One writer per product.** A finals chunk holds a whole year, so two runs
writing two months of one year at once would each upload the year's chunks
with only their own month changed, and the later upload would put the other
month's old values back. Every run first takes the product's lease
(`lease.py`): `ingest-state/<product>/lease.json`, created with S3's
`If-None-Match: *`, expiring after 20 minutes (longer than Lambda's 15), and
taken over from a dead run with `If-Match` on its ETag. A monthly run that
finds it held ends quietly; a backfill raises `MirrorBusy`, for the Step
Functions map to retry. A conditional put on the manifest alone wouldn't
do: by then the chunks are already up.

**One process asking CHC at a time.** CHC asked for about one request a
second in total across all our Lambdas, and the backend's fetcher Lambda asks
CHC too (per-feed fetches, the daily preliminary and GEFS passes). Before a
`rnl` or `sat` run asks CHC anything (and before it takes the product's
lease), it takes the slot it shares with the fetcher (`lease.hold_host`):
`ingest-state/hosts/chc/lease.json`, by the same conditional writes, with the
holder's name (`ingest:rnl:backfill`) and an expiry of the Lambda's time left
plus a minute, so a run killed by its timeout frees it a minute later.
Held by the fetcher, a monthly run ends quietly (`busy` in its answer, the lag
still published; tomorrow's catches up) and a backfill month raises
`HostBusy` (a `MirrorBusy`), which the state machine retries every 2 minutes
for an hour (`infra/ingest_backfill.tf`). The Node side is
`backend/src/feeds/hostSlot.ts`; both read and write the same JSON
(`owner`, `expires` in epoch seconds, `holder`). Locally the slot is the same
file under the `file://` copy.

**A backfill execution keeps the slot for its whole run**
(`lease.hold_host_for_backfill`, issue #618 step 4). The state machine adds
`"hold": {"execution": <execution id>, "pauseSeconds": n}` to each month, so
every month takes the slot as owner `backfill:<execution id>` (holder
`ingest:backfill:<execution name>`), finds it its own when an earlier month
left it, and on the way out (success or failure) keeps it until now + the
pause + 5 minutes instead of releasing it. The execution's last step sends
`{"mode": "release_hold", "hold": {"execution": …}}`, which releases only that
execution's hold. A month that dies, or an execution stopped by hand, leaves a
hold that expires on its own; to free it at once, delete
`ingest-state/hosts/chc/lease.json` (docs/deployment.md § Backfill). A month
that finds the slot held by anyone else reserves the next turn
(`ingest-state/hosts/chc/reserved.json`, 5 minutes, renewed by each retry);
any other taker, here or in the fetcher, that takes a free slot with someone
else's live reservation gives it back and is busy. The hold's take, keep and
release are logged with the holder's name. A backfill event sent by hand
without `hold` holds the slot for its own invocation only.

**A 403 stops the run** (`polite.StopRun`) with no retry. The error
propagates, so the Lambda errors and the DLQ and the errors alarm see it.

**`MirrorLagDays`** (`cloudwatch.py`; namespace `water-management/Mirror`,
dimension `Product`, value today UTC minus `finalThrough` in days, or since
the day before the product's first month when nothing is held) is published
on every exit once the event is valid and `MIRROR_URL` is set: a 304, a run
that copied, a run the budget cut short, a monthly run held off by the lease,
and every failure, before the error is re-raised. The lag alarms treat a
missing datapoint as breaching, and `test_chirps_final.MetricOnEveryExit`
walks every exit to keep it that way.

## IMERG Late

`imerg.py` (issue #604 R4-D) copies NASA's GPM IMERG Late daily rain
(`GPM_3IMERGDL`, about 14 h behind) for the last few days into
`imerg_late/`, for the days CHIRPS has no preliminary value for yet. Which
days the engine takes from it is decided later, in the engine; this job only
keeps the copy. Runbook: docs/deployment.md § IMERG Late; source:
docs/data-sources.md § imerg.

**A run** (`recent`, 4 times a day):

1. A refusal earlier the same UTC day (`ingest-state/imerg_late/refused.json`)
   ends it with no request (`stopped: "refused_today"`).
2. It holds the product's lease (`lease.py`); held by another run, it ends
   (`stopped: "busy"`).
3. Days older than 30 are dropped: out of the manifest, then their chunks.
4. One CMR search (`cmr.earthdata.nasa.gov/search/granules.umm_json`,
   `short_name=GPM_3IMERGDL`, versions 07 and 08, no sign-in) for the last
   `days` days through yesterday. For each day the newest version listed
   wins; a day already held from the same granule URL costs nothing.
5. Each remaining day, newest first, is one OPeNDAP DAP4 request for region
   D1 only (`<granule>.dap.nc4?dap4.ce=/precipitation[0:1:0][1900:1:2209][545:1:819];…`,
   ~0.2 MB instead of the 26 MB global file), at most one request a second,
   while the Lambda has 60 s left. The Earthdata token goes in
   `Authorization: Bearer`, to `opendap.earthdata.nasa.gov` and
   `data.gesdisc.earthdata.nasa.gov` only, as an unredirected header (never
   copied onto a redirect); landing on Earthdata Login's page counts as a 401.
6. Each day is read, checked (0–2000 mm), hashed (`valuesSha256`) and
   written; the manifest is saved after every day.

**The file.** `precipitation(time, lon, lat)` float32, **lon before lat**,
lon −179.95…179.95 and lat −89.95…89.95 ascending (centres on x.x5),
`_FillValue` −9999.9, units `mm/day` (the day's mean rate, so the day's mm).
The reader places every cell from the coordinates, so the copy's row 0 is the
southernmost and column 0 the westernmost whatever the file's order; it
refuses another variable name (V06's `precipitationCal` by name), units
other than mm/day, a time not on the day, packed values, and anything that
isn't HDF5 (a login page).

**The copy** `imerg_late/`: the 0.1° daily layout, shape (days, 275, 310),
chunk (1, 55, 62), `[0, 0]` centred at −35.45, 10.05; `firstDay` is 30 days
before the run that made it. The manifest's `grid.step` is 0.1,
`finalThrough` is always null, and `prelimThrough` is the end of the
contiguous run of held days from the oldest. **Each `files` entry carries
`version`** (`V07`, `V08`): the collection version the day came from, for
fitting bias correction per version; the file's minor letter (V07C) stays
in its URL. `imerg.py` checks that field itself until `manifest.py` knows
it (R4-B). A held day whose granule changes (V08 arrives) is fetched again:
the same values move only the URL and version, other values bump the
revision with a one-day `changes` entry.

**The credential** (`earthdata.py`, live mode only). The secret holds a
bare Earthdata Login user token (used as it is, rotated by hand every 60
days) or a login, JSON `{"username", "password"}` (nothing else; anything
else starting `{` is refused with a clear `SecretFormatError`). With a login
the run asks Earthdata Login's user token API
([docs](https://urs.earthdata.nasa.gov/documentation/for_users/user_token)),
HTTP Basic, at `urs.earthdata.nasa.gov`:

- `GET /api/users/tokens` lists the account's tokens; the one that lasts
  longest is used if it has more than 7 days left (`REFRESH_DAYS`);
- otherwise `POST /api/users/token` creates one. An account holds at most 2:
  on `403 max_token_limit` the run revokes the listed token that ends first
  (`POST /api/users/revoke_token?token=…`; by then within 7 days of its end
  or past it) and creates again.

A token's end is its JWT `exp` (the payload only is decoded, no signature
check: a date is all it reads), else EDL's `expiration_date`. The token
stays in memory for the run: never logged, never written back to the
secret (the role has `GetSecretValue` alone). These calls send the ingest
User-Agent, a 30 s timeout and one request a second, and don't take CHC's
request slot. Errors name the endpoint's path and EDL's error code, never
the token, the password, the Authorization header (an unredirected header)
or the revoke URL. Each live run publishes
**`EarthdataTokenDaysLeft{Product=imerg_late}`**, the whole days left on
the token in use (none for a token with no readable end), which
`infra/imerg.tf`'s `earthdata-token-expiring` alarm watches (under 10).

**Refusals.** A 403 from either host, or a 401 (a token that expired or was
never approved for GES DISC), stops the run, never retried, writes
`refused.json` (`{v, day, at, status, host}`) and re-raises, so the Lambda
errors and the DLQ sees it. The marker keeps the day's later runs from
asking; the next UTC day tries again. A marker that isn't one never blocks.
Earthdata Login refusing the stored login (401, or a 403 other than the
token limit) is the same (`earthdata.LoginRefused`, host
`urs.earthdata.nasa.gov`), so a wrong password is tried once a day; the run
publishes `EarthdataTokenDaysLeft` 0, and the message says whether the
account's multi-factor sign-in is the cause when EDL says so (an MFA account
may not take Basic auth; then store a bare token).

**`MirrorLagDays{Product=imerg_late}`** on every exit once the event is
valid and `MIRROR_URL` set: today minus `prelimThrough`, or 11 with nothing
held.

**Locally**, fixtures mode reads no token and touches no network:
`imerg_fixture.FakeEarthdata` answers the search with one granule a day up
to yesterday and cuts each subset from `fixtures/imerg`'s synthetic field:

```sh
MIRROR_URL=file://$PWD/ingest/.mirror ingest/.venv/bin/python ingest/imerg.py 3
```

## The ERA5-Land job

Product `era5l`: ERA5-Land daily total precipitation from the Copernicus
Climate Data Store (dataset `reanalysis-era5-land`, CC BY 4.0, about 5 days
behind), into a **finals** array on the **0.1° grid** (r4-shared.md): shape
(years from 1950, 366, 275, 310), chunk (1, 366, 20, 20), cell [0, 0]
centred at lat -35.45, lon 10.05, attributes `firstYear` 1950, `region`,
`grid` (step 0.1) and `attribution` (Copernicus's text). The manifest is the
usual one with `grid.step` 0.1; each `files` entry is one month's request,
`url` `cds://reanalysis-era5-land/total_precipitation/YYYY-MM`, with no ETag.
The module's docstring is the full design; in short:

- **A day is the UTC day.** ERA5-Land's `tp` accumulates from 00 UTC, so the
  00 UTC step of D+1 is day D's total: one field a day, m × 1000 = mm. A
  month's request asks for the 00 UTC steps of its own days, so it writes
  the last day of the previous month through its own second-last day; the
  month's last day comes with the next month's request. `finalThrough` is
  the end of the contiguous run of days the months held write (ERA5-Land-T
  days included: a revision later marks them, as below); both manifest
  validators (`manifest.py`, `backend/src/mirror/manifest.ts`) refuse a
  manifest that claims more, or a file URL, ETag or Last-Modified other
  than a month request's.
- **The remap.** ERA5-Land's points are on x.x0°; the copy's cells are
  centred on x.x5°, so each cell is the mean of its four corner points (a
  quarter of each box: the area-weighted remap). Sea points have no value;
  a coastal cell averages the corners that do.
- **Submit, then collect.** A run never waits for the CDS's queue. It writes
  its intent to `ingest-state/era5l/requests.json`, submits, and records the
  request's id; a later run asks its status and, once it is `successful`,
  downloads the result (polite client) and writes it. At most one request
  per month and `MAX_IN_FLIGHT` (4) in all. If the state is lost, or a run
  died between the intent and the id, the next run looks for its own queued
  request among the account's ten newest jobs before submitting again.
- **A failed request** (failed, rejected, deleted, gone) is resubmitted after
  1, 2, 4, then 8 days. After 5 failures the run stops resubmitting it and
  raises `RequestsFailed` every run (the errors alarm). To try again, read
  its `lastError`, fix the cause, and delete that month's entry from the
  state file.
- **monthly** (the daily rule): collect; then request the newest complete
  month (its last day 6 days old) and any month after the newest held one,
  at most 12 back; then re-request each held month that may still change.
- **ERA5-Land-T revisions.** The newest months are preliminary (the file's
  `expver` is not 0001), replaced by the consolidated data about two months
  on. Such a month (or one whose phase is unknown) is requested again 75
  days after it ends, then every 30 days while still preliminary. A month
  whose phase stays unknown (no `expver`) is asked for every 30 days too,
  until a read says consolidated or 180 days after its end
  (`RECHECK_UNKNOWN_CAP_DAYS`), when it counts as final: without `expver`
  the copy can't tell, so it keeps asking through the window in which
  ECMWF consolidates, with room for a late one. CHIRPS's
  revision rule applies: a new revision with a `changes` entry only when the
  values' hash changed.
- **backfill** marks its month wanted and submits it when a slot is free;
  every later run, the daily one included, keeps submitting wanted months
  (newest first) as slots free up. AWS's `nsf-ncar-era5` holds ERA5, not
  ERA5-Land, so the backfill goes through the CDS too.
- **Checks and stops:** the 0–2000 mm check after the remap (negative
  packing noise above -0.001 mm becomes 0), the values hash, the lease, a
  401 or 403 that stops the run (never retried) and writes
  `ingest-state/era5l/refused.json` so no other run that UTC day calls the
  CDS, and `MirrorLagDays{Product=era5l}` on every exit (before any month is
  held it counts from 1949-12-31).
- **The key** is read from Secrets Manager (`CDS_KEY_SECRET_ARN`) in live
  mode, only when the run first calls the CDS. `LiveCds` wraps
  `ecmwf-datastores-client` with our User-Agent, one call a second and no
  client-side retry loop; the result file comes through `polite.py`.

Operator steps (the CDS account, the licence, the key, turning it on, the
backfill): docs/deployment.md § ERA5-Land.

## Reference evaporation

Issue #604 R5-E: a **current-season** daily reference evapotranspiration
beside dPET's climatology (docs/maps.md § Evaporation from the map). This job
keeps the copy; how the app uses it is the backend's and the engine's.

**`agera5_et0`** (`agera5.py`; its docstring is the spec): AgERA5 v2.0,
CDS dataset `sis-agrometeorological-indicators`, variable
`reference_evapotranspiration` (FAO-56 Penman-Monteith, mm/day), area D1,
one request per month (its calendar days: AgERA5's days are local days) into
the finals layout at 0.1°, year axis from 1979, with Copernicus's credit in
the array's `attribution`. Runs exactly as ERA5-Land's (`cdsjob.py`: submit
on one run, collect on a later one, at most 4 queued, backoff and the loud
stop after 5 failures, a 401/403 silencing the CDS for the UTC day, the
lease). The file never says whether a month was built from ERA5T, so each
held month is asked for again 75 days after its end and every 30 days to 180
days; a new revision only when the values change. 0–30 mm/day, else the run
fails before writing. `MirrorLagDays{Product=agera5_et0}` = today −
`finalThrough` (from 1978-12-31 while empty).

**`power_et0`** (`nasapower.py`): the fallback for the days AgERA5 doesn't
hold yet. NASA POWER publishes no reference ET, so the job asks its daily
**regional** API (community AG, JSON, LST days; no key) for `T2M_MAX`,
`T2M_MIN`, `T2MDEW`, `WS2M`, `ALLSKY_SFC_SW_DWN` and `PS`, **one parameter a
request** (POWER's regional rule), over D1 cut evenly into 12 tiles of at
most 10° a side: 72 requests a run at one a second, a 403/401 stopping the
run and the UTC day. `fao56.py` turns each POWER point-day into ET₀ (NaN
where any input is POWER's -999 fill or missing); each 0.1° cell takes the
nearest point's value (placed by the response's coordinates; the points must
form a lattice), so 25 cells share one 0.5° value. Daily layout at 0.1°,
array `firstDay` 1981-01-01, one manifest file a day
(`power://temporal/daily/regional/fao56-et0/YYYY-MM-DD`), `prelimThrough` the
newest held day, the newest 120 days kept. Each run re-reads the last `days`
(30) days ending 3 days before today, since POWER revises recent days; a day
POWER doesn't have yet is skipped, and a run out of time writes nothing.
`MirrorLagDays{Product=power_et0}` = today − `prelimThrough`.

**Unverified until the first live run** (none of it can be checked without
the CDS key, and we make no live request from a session):
- AgERA5's lag (`AVAILABLE_AFTER_DAYS` = 10 assumes about a week), the exact
  variable name and units string in its files (any single data variable in
  mm/day is taken, anything else refused by name), and whether the download
  is a zip of daily files or one NetCDF (both read);
- POWER's largest regional box (the tiles' 10° is a constant) and whether a
  regional request honours `time-standard=LST`.

Operator steps (turning the schedules on, the CDS licence for AgERA5 on the
existing account): docs/deployment.md § AgERA5.

## A modelled Class-A pan

Issue #646 item 7: a Class-A pan grid where no pan station is near, for
Evaporation from the map's A-pan row (docs/maps.md § The evaporation grid).
**Offline and operator-run**: `penpan.py` and `apan_grid.py` aren't in the
image, and nothing here writes the copy.

- **`penpan.py`** (stdlib only; its docstring cites each equation): PenPan,
  S6.1 with the pan's shortwave (S6.4–S6.6), FAO-56's net longwave and
  Thom's pan vapour transfer (S6.2). `monthly_mm` takes a month's mean daily
  weather and returns its total (steady state). Our choices: f_dir kept
  within 0–1, unscreened output (`screen` 0.93 for a bird screen), ground
  albedo 0.23, never negative. PenPan-V2 is not implemented
  (docs/followups.md).
- **`apan_grid.py fetch`**: NASA POWER's daily regional API, the six
  parameters `nasapower.py` reads, one year at a time over the box's tiles
  (4 for South Africa, so 24 requests a year at one a second, a 403/401
  stopping the run). Each year is reduced to each point's monthly means
  (a month with a missing day is null) in `<dir>/<year>.power-monthly.json`,
  and a year already there is skipped. The copy can't supply this: it holds
  only AgERA5's and POWER's reference ET. `--fixtures` answers from
  `power_fixture.FakePower`.
- **`apan_grid.py grid`**: PenPan per point and month, averaged over the
  years (a point needs every month of every year), on 0.1° cells centred on
  x.x5° (the nearest point's), refusing a month over 1 000 mm. The output is
  the `apan` form `pnpm import:evaporation` reads, with `model`, source,
  version and POWER's attribution.
- **`apan_grid.py validate`**: the grid against a CSV of Class-A pan
  stations (`station,lat,lon,jan,…,dec`, mean monthly mm). It writes a
  Markdown report of the ratio, bias and RMSE by month and overall.

The operator's run and the production block: docs/deployment.md §
Reference datasets.

## The C3S seasonal job

Issue #620 step 5: the multi-system seasonal forecasts the outlook will be
conditioned on (steps 6–7; nothing reads the copy yet). `c3s_seasonal.py`'s
docstring is the spec; in short:

- **Source:** CDS dataset `seasonal-original-single-levels`,
  `total_precipitation` (accumulated since the start, m), every member,
  `leadtime_hour` 24–5160 (215 days), area [-8, 10, -36, 41] at the native
  1°, GRIB. One request per **system** (`c3srequest.SYSTEMS`,
  `<centre>-<system>`: `ecmwf-51`, `ukmo-604`, `meteo_france-9`, `dwd-22`,
  `cmcc-35`, `ncep-2`, `jma-3`, `eccc-4`, `eccc-5`) per **init month**, and,
  for the hindcasts, one per system per init calendar month asking every
  year of 1993–2016 at once.
- **When:** ECMWF's init M is on the CDS from the 6th of M at 12 UTC, the
  others' from the 10th (`release_at`); a run asks for it 30 minutes after.
  The daily `monthly` run collects what is ready, then submits each system's
  newest released init (and the one before it if missed, `CATCH_UP_INITS`),
  newest first, then the wanted hindcasts. A `backfill` event marks one init
  month's hindcast wanted (every system, or one) and does the same.
- **The machinery is ERA5-Land's**, keyed by request (`fc/<system>/<YYYY-MM>`,
  `hc/<system>/<MM>`) in `ingest-state/c3s/requests.json`: the intent
  before the submit, adopting a queued request after a crash or a lost
  state, at most 4 queued, backoff 1–16 days and `RequestsFailed` after 5,
  the same-day refusal marker on a 401/403, the lease (`c3s`), the polite
  download, the key from `CDS_KEY_SECRET_ARN` in live mode only. It reuses
  `cdsjob.py`'s pieces (`LiveCds`, the key, the backoff) but runs its own
  loop, since `cdsjob.run` is keyed by month.
- **Decoding:** eccodes reads the GRIB twice, the headers (which starts,
  members and leads are there; anything but the request's own `tp` is
  refused) and then the values. The points are the 1° grid's cell centres,
  so no remap. Day d = 1000 × (tp[24(d+1) h] − tp[24d h]) mm, tp[0 h] = 0,
  de-accumulated in place; noise down to −5 mm clamped to 0; further below
  or above 2000 mm fails before anything is written. A missing field leaves
  the days it bounds NaN; the lead axis is always 215 long.
- **The grid:** `grid.C3S`, the third grid spec beside 0.05° and 0.1°: D1's
  bounds snapped outward to whole degrees as the cell centres (36–8° S,
  10–41° E), 29 rows × 32 columns, [0, 0] centred at 36° S, 10° E, rows
  northwards; its box `grid.SEASONAL_REGION` (9.5–41.5° E, 36.5–7.5° S) is
  what the arrays' and manifests' `region` says
  (`backend/src/mirror/grid.ts` `SEASONAL_REGION` agrees).
- **What is written:** Zarr groups with one float32 array `tp_mm` (mm/day,
  NaN fill, gzip, one chunk per member's whole forecast):
  `c3s/<YYYY-MM>/tp_mm` (system, member, lead_day, lat, lon), each system
  written into its slot as it is collected, members padded with NaN to the
  largest system's; `c3s-hc/<system>/<MM>/tp_mm` (year, member, lead_day,
  lat, lon), written whole. The group's attributes carry the coordinates
  (`systems` or `years`, `members`, `init`/`initMonth`, `firstDay`,
  `leadDays`) and the credit: `source`, `licence`, `credit`, `citation` and
  `centres` (the contributing centres' names). Each product's manifest lists
  one file per request (`cds://seasonal-original-single-levels/total_precipitation/<system>/<YYYY-MM>`
  or `…/hindcast/<MM>`, no ETag; `years` the init's to the last lead's, or
  the hindcast years held), and `c3s/index.json` what is held:
  `{"inits": {"YYYY-MM": [systems]}, "hindcasts": {system: ["MM"]}}`.
- **`MirrorLagDays{Product=c3s}`:** today minus the 1st of the newest init
  every system of `SYSTEMS` is held for; none held, nothing published (the
  alarm treats that as breaching).

**Unverified until the first live run** (no live request is made from a
session): the GRIB's exact keys for each centre (lagged-start systems'
`dataDate`s are taken by year and month only), whether the CDS accepts a
whole hindcast month in one request, and each system's member and hindcast
year counts.

Operator steps (both licences on the dataset's page, turning it on, the
hindcast backfill): docs/deployment.md § C3S seasonal forecasts.

## NEX-GDDP-CMIP6, once

Issue #621 slice 2: the climate projections the future yield's change
factors are computed from (slices 3-4; nothing reads the copy yet).
`cmip6_delta.py`'s docstring is the spec; in short:

- **Once, by the operator.** The archive is static (no updates are
  planned), so there is no schedule, no Lambda and no `infra/` change: the
  operator runs it once in us-west-2, next to the bucket, and only the
  regional monthly aggregates travel to the copy in af-south-1 (the runbook:
  docs/deployment.md § NEX-GDDP-CMIP6 (one-off)). `plan` first: it lists
  what `copy` would read and what is missing without reading any data.
- **Source:** `s3://nex-gddp-cmip6/NEX-GDDP-CMIP6/<model>/<scenario>/<variant>/<var>/<var>_day_<model>_<scenario>_<variant>_<grid>_<YYYY>[_v<N.N>].nc`,
  anonymous (read unsigned), daily, global 0.25°. `pr`, `tasmax` and
  `tasmin` for `MODELS` (ten, frozen in docs/data-sources.md §
  nex-gddp-cmip6) × `historical` 1985–2014, `ssp245` and `ssp585`
  2036–2095. The highest version of each file is read (no suffix is the
  first release, `v1.0`); a model listing two variants needs one pinned.
- **Reading:** ranged GETs through a block cache (`S3RangeFile`), asking
  HDF5 for D1's cells only. Cells are placed by coordinate (either latitude
  direction), the margin is dropped. Time is decoded in the file's own
  calendar (Gregorian, `noleap`, `all_leap`, `360_day`), and must be every
  day of the file's year once. pr in kg m⁻² s⁻¹ (× 86400 mm/day, 0–2000),
  temperatures in K (170–340); anything else stops the run before the year
  is written.
- **What is written:** monthly aggregates only, never a day. A group per
  product with `pr_mm` (the month's total, mm), `tasmax_c` and `tasmin_c`
  (the month's mean, °C), float32, dims (year, month, lat, lon) on
  `grid.CMIP6` (110 × 124 cells tiling D1 exactly, [0, 0] centred at
  35.375° S, 10.125° E), chunk (1, 12, 22, 31), year index from 1950
  (historical) or 2015 (the SSPs). A month with a day missing at a cell is
  NaN there. The group's attributes carry the model, variant, grid label,
  calendar, the source, the licence, the credit, the citation and the
  method. The manifest lists one file per NEX file, each with its `version`
  and its global `license` attribute **verbatim** (null when it has none),
  `valuesSha256` hashing that file's (month, lat, lon) aggregates; `years`
  the first and last held. `cmip6/index.json` lists the years held per
  model and scenario.
- **Licence:** the AWS registry says CC0 for every output since September
  2022; the archive was first released under CC BY-SA 4.0, which is why
  each file's own attribute is kept, and the run's summary counts every
  distinct value it met.
- **Resuming:** a year whose three files the manifest already lists is
  skipped without a read; a newer version replaces its entry (a revision
  with a `changes` entry only when the aggregates differ).

**Unverified until the first live run** (no session has listed the bucket):
the key layout and version suffixes, each model's variant and grid label,
the files' chunking (and so how much of each a region read costs), and the
`license` attribute's presence and wording.

## The ECMWF forecast job

`ecmwf_forecast.py` (issue #604 D17, R4-C; its docstring is the spec) copies each
00 UTC run of ECMWF's ensemble from its open data bucket
(`https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com/<YYYYMMDD>/00z/ifs/0p1/enfo/<YYYYMMDD>000000-<step>h-enfo-ef-sfc.{index,grib2}`,
the 0.1° files ECMWF publishes from 2026-10-20, about 09:40 UTC):

1. **Today's issue, else yesterday's.** One held already ends the run. With
   no work saved for it, the last step's index is asked for first: a 404
   means the issue isn't out.
2. **Each step** (24 … 360 h): the `.index` (JSON lines, one per field,
   with `_offset`/`_length`), then one range request per member for its
   `tp` field only, one request a second. Each field is decoded with
   eccodes and checked (`tp` in m, this run, accumulated from 0 h to the
   step, this member, a regular lat/lon grid); our 0.1° cells (centred on
   .05) take the mean of the four field points at their corners. The step's
   members are saved to `ingest-state/ecmwf/work/<issue>/step-<h>.npy`, so
   a run stopped by its time budget is resumed by the next.
3. **The issue.** Day d is `1000 × (tp[24(d+1) h] − tp[24d h])` mm, the UTC
   day issue + d (day 0 is the issue date, as for CHIRPS-GEFS); a round-off
   below zero is 0, a real drop, a gap or over 2000 mm fails. Per cell and
   day the ensemble mean, p10, p50 and p90 go into Zarr `ecmwf/<issue>`
   (dims stat, day, lat, lon; chunk (1, 1, 55, 62)), then its manifest, then
   `ecmwf/index.json`.
4. **Keeping:** the newest 7 issues whole; older ones keep only their mean
   (listed as `archived`) for the quantile-mapping fit.

A 403 stops the run (never retried) and writes `ecmwf/refused.json`; later
runs that UTC day ask nothing. The lease is `ingest-state/ecmwf/lease.json`.
`MirrorLagDays{Product=ecmwf}` (today minus the newest issue held) goes out on
every exit once an issue is held. `pnpm dev:ingest:run ecmwf` runs it in
fixtures mode (`ecmwf_fixturehttp.py`).

**The fit** (`ecmwf_qm_fit.py`, the operator, offline): empirical quantile
mapping of the archived ensemble means against the copy's `sat` rain (else
`prelim`) for the same 0.1° cell and day, per region and season, written to
`ecmwf/qm.json`; the feed applies it (`backend/src/feeds/fromMirrorEcmwf.ts`)
and labels the forecast "not yet calibrated" without it. Runbook:
docs/deployment.md § ECMWF.

**eccodes** comes as binary wheels (`eccodes` plus `eccodeslib`, which
bundles libeccodes, libaec, OpenJPEG, libpng and eckit): cp314
manylinux_2_28 wheels exist for x86_64 (CI) and aarch64 (the image), so
nothing is built and no system package is needed.

## The copy

One Zarr v3 hierarchy per environment. Each product is an array at
`<product>/` with its manifest at `<product>/manifest.json`. The layouts and
the manifest are specified in issue #604 (D2 and "Manifest spec"), and the
Node reader in `backend/src/mirror/` reads the same files:

- **Region:** 10–41°E, 35.5–8°S, which is 550 rows × 620 columns on CHC's
  0.05° grid. `[0, 0]` is the south-west cell (centre −35.475, 10.025). Rows
  grow northwards and columns eastwards. Indices always come from the origin
  and the step, because CHC's coordinates are float32 (`10.024994`).
- **Finals** (`rnl`, `sat`): float32, shape (years, 366, 550, 620), chunk
  (1, 366, 20, 20), `firstYear` 1981. The doy index is the number of days
  since 1 January, so index 365 stays NaN in a non-leap year.
- **Daily** (`prelim`, `gefs/<issue>`): shape (days, 550, 620), chunk
  (1, 110, 124), day index = days since `firstDay`. `zarrstore.write_daily`
  writes it. No product uses it in Round 1.
- **Both:** NaN is the fill value (CHC's −9999 becomes NaN), with codecs
  `bytes` (little-endian) then `gzip` level 6. Chunks that are all NaN are
  never written.
- **S3** goes through boto3 by staging. The objects a write can touch (the
  root `zarr.json`, the array's `zarr.json` and the chunks of the years
  written) are copied to a temporary directory, and zarr writes there. Then
  only the objects that changed are uploaded, and any chunk zarr deleted is
  deleted. A month's write touches one year's chunks, at most 868 objects.

**`finalThrough`:** the last day of the **contiguous** run of months the
manifest's `files` hold, from the first month copied
(`manifest.finals_coverage`; each byMonth URL names its month). It moves
forward only when the next month is copied: after a partial backfill plus the
newest month, it stays at the end of the backfill, so the months between are
never read as final (a NaN there would be cached as final no-data for good).
A byMonth file must hold days of the month its URL names, through that
month's last day, or the run refuses it. Both validators (`manifest.py` and
`backend/src/mirror/manifest.ts`) refuse a finals manifest whose
`finalThrough` runs past that run, or whose file URL names no month.

**Plausible values:** after CHC's fill becomes NaN, every value must lie in
0–2000 mm, the bounds the Node reader holds a day's rain to. A file with a
value outside them fails the run (`chcnetcdf.ImplausibleValueError`) before
anything is written, so the alarm fires instead of one bad cell failing every
feed over it for good.

**Revisions (D8):** each file's `valuesSha256` is the SHA-256 of its region
values as float32 little-endian bytes in (day, lat, lon) order, with every NaN
written as `0x7FC00000`. When a file is copied again:

- with the same hash, only its `fetchedAt` moves, and no chunk is rewritten;
- with a different hash, the product's `revision` goes up by one and a
  `changes` entry is added, giving the days, the number of cells that changed
  and the largest absolute difference.
- unless the copy no longer holds the previous file's values (their hash
  doesn't match the file's `valuesSha256`). That happens when a run died after
  uploading some or all of the new chunks but before writing the manifest:
  the retry reads the new values back, and a diff would claim 0 cells, which
  `245_mirror_revision.sql` skips, leaving stale cached finals unmarked. The
  old values are unknown, so the entry claims every cell of the region
  (341,000) and a `maxAbsDiff` of 2000, the widest difference two plausible
  values can have: an upper bound, never 0.

## The polite client

`polite.PoliteClient` is the only way this job reaches the network:

- **User-Agent:** `water-management-ingest/1 (+https://github.com/Absence0760/project-water-management; <INGEST_CONTACT>)`.
- **Conditional GETs:** it sends `If-None-Match` and `If-Modified-Since`, and a 304 means the file is skipped.
- **Pacing:** at most one request a second (`min_interval`), retries included, and one request at a time.
- **Range requests:** `byte_range=(first, last)` sends `Range` for a few pixels of a TIFF (`verify_copy.py`), paced like any request.
- **429 and 503:** it waits as long as `Retry-After` asks, given in seconds or as an HTTP date. It retries at most `max_retries` times and gives up (`RetryLater`) rather than wait longer than `max_wait`.
- **403:** it raises `StopRun` at once, with no retry. The run stops and the alarm fires, because CHC bans by volume.
- **A body that ends early:** when the response has a `Content-Length` (and no `Content-Encoding`), the bytes received must match it, for a 200 and for a 206's part. A short body, or a connection that breaks mid-body (`IncompleteRead`, a reset, a timeout, a TLS EOF), is a failed request, never a file: it is retried, paced and counted like any request, backing off `truncated_backoff` (default `default_backoff`, 30 s) doubling, at most `max_retries` times and only while `may_retry(wait)` allows, then raises `TruncatedDownload` (a `RetryLater`). http.client's `read(amt)` returns a short body without raising when the server closes early, so before this a dropped connection reached the NetCDF reader as a truncated file (the 1986-08 backfill month, 2026-10-30). The CHIRPS finals runs (`lambda_handler.py`) wait D4's 60 s before asking again and retry only while a whole download still fits the Lambda's time (`Budget.allows`); past that the invocation fails with `TruncatedDownload`, which the backfill state machine retries (docs/deployment.md § Backfill). No `Content-Length` (a chunked body) is accepted as before. `cdsjob.py` still checks the size against the CDS's own `content_length` too: a different source of truth, not a second retry.

## Verify the copy

`verify_copy.py` is run by the operator once the backfill is done, before
the worker reads the copy (docs/deployment.md § Backfill, steps 4–5). It
never runs in Lambda or CI. It reads the copy at `MIRROR_URL` (`file://` or
`s3://`, through boto3 with the operator's credentials) and writes a
Markdown report, to stdout or `--out`. The exit status is 0 when every
check it ran passed and 1 otherwise, so the runbook can gate the switch on it.

```sh
MIRROR_URL=s3://<mirror bucket> ingest/dev.sh verify --out /tmp/verify-copy.md
ingest/dev.sh verify --no-network --mirror file://$PWD/backend/fixtures/mirror --first-month 2023-01   # coverage only, offline
```

`ingest/dev.sh verify` makes `ingest/.venv-verify` (gitignored) from
`requirements-verify.txt` on first use. That file is the image's pins plus
`icechunk`, hash-pinned the same way, and Dependabot's `/ingest` pip entry
bumps it (never auto-merged). `--checks` picks the checks (default all
three), and `--no-network` runs only coverage:

- **coverage**: each finals manifest's `files` hold every month from the
  product's first (`rnl` 1981-01, `sat` 2000-06; `--first-month` for a
  partial copy) with no gap. `finalThrough` must be the last day of that
  contiguous run (`manifest.finals_coverage`) and at most `--max-lag-days`
  (75, the lag alarm's default) old. It reads the JSON itself rather than
  through `manifest.validate`, so it reports every problem at once.
- **chc**: `--samples` cell-days (200), seeded (`--seed`, 604). They are
  split evenly between `rnl` and `sat`, and within each product evenly
  across its years (every decade is drawn from), with a uniform day and
  cell. Each is read from the copy's chunk and from CHC's daily GeoTIFF
  (`final/<product>/YYYY/chirps-v3.0.<product>.YYYY.MM.DD.tif`, the files
  the cache read before the copy) with `tiffread.py`. That takes three range
  requests: the header, the image directory, and the pixel's strip. Every
  request goes through `polite.PoliteClient` (`byte_range`): one at a time,
  at most one a second, with the job's User-Agent. An HTTP 403 (or a
  `Retry-After` too long to wait) stops the run, and the report says
  **Stopped**. Values must be **bit-equal**, where no data on both sides
  counts as equal. A different cell-day fails and is listed with both
  values; a missing or unreadable file fails too.
- **dynamical**: the whole region of `rnl` for one whole month per decade
  (seeded, or `--month YYYY-MM`, repeatable), clipped to the days
  dynamical.org holds. It compares against dynamical.org's Icechunk store
  (`s3://dynamical-ucsb-chc-chirps/ucsb-chc-chirps-analysis-final/v0.1.0.icechunk`,
  us-west-2, anonymous; variable `precipitation_surface`). Its kg m⁻² s⁻¹
  is multiplied by 86,400 in float32, its north-up rows are flipped, and
  its cell centres are checked against D1's. The land/sea mask must match
  exactly, and the relative difference on wet cell-days (copy ≥ 1 mm) must
  stay within `--tolerance` (0.002). Round 0 measured a median of 0.067% and
  a maximum of 0.195% for June 2024. The report gives the median, p99,
  maximum and largest absolute difference per month. dynamical.org rounds
  to 8 mantissa bits, so its values never bit-match; that is why only CHC's
  own files are the bit-for-bit check.

`tiffread.py` reads what the backend's `tiff.ts` reads (classic TIFF in
either byte order, one float32 band, strips, LZW, deflate or none, no
predictor, WGS 84 degrees) and refuses anything else. CHC's files are LZW
with one row per strip and the IFD at the end, so the image directory and
the strip table come in one 64 KiB read.

## Run it locally

Optional, like `gen:help-art`: `pnpm dev`, e2e and the other CI jobs never
need Python. Each command creates `ingest/.venv` (gitignored) from the
hash-pinned `requirements.txt` the first time it runs, and again whenever that
file changes.

```sh
pnpm dev:ingest:run          # rnl into ingest/.mirror (gitignored); `pnpm dev:ingest:run sat` for sat
pnpm dev:ingest:run era5l    # ERA5-Land from the fake CDS: the first run submits, the second collects
pnpm dev:ingest:run imerg_late  # IMERG Late's last ten days from the fake Earthdata (a recent run)
pnpm dev:ingest:run ecmwf    # the ECMWF forecast from the committed synthetic GRIB2 (a daily run)
pnpm dev:ingest:run agera5_et0  # AgERA5 reference ET from the fake CDS: the first run submits, the second collects
pnpm dev:ingest:run power_et0   # NASA POWER ET0 from the fake POWER (a recent run, 30 days)
pnpm dev:ingest:run c3s      # C3S seasonal from the fake CDS: four systems a run, submitted then collected (run it 3-4 times)
pnpm test:ingest             # the unittest suite
ingest/dev.sh cmip6 plan     # the one-off NEX-GDDP-CMIP6 copy on the synthetic tree: what it would read
ingest/dev.sh cmip6 copy     # … and the copy itself, into ingest/.mirror
```

`dev:ingest:run` only writes to a `file://` copy and refuses an `s3://`
`MIRROR_URL`. `PYTHON=<interpreter>` picks another Python 3.14.

## Tests

The tests use stdlib `unittest`, the same exception the importer and
`verify/` have:

```sh
ingest/.venv/bin/python -m unittest discover -s ingest
```

They cover:

- **The polite client:** pacing, the 304 skip, the 403 stop, `Retry-After` given in seconds or as a date, and a body that ends early (short of its `Content-Length`, or broken mid-read) retried then refused with `TruncatedDownload`, in memory, to a file and for a 206 part; no `Content-Length` accepted as before. They run against a fake opener and clock, so nothing touches the network or sleeps.
- **The writer:** the exact D2 metadata, and where a known cell-day lands, for leap and non-leap years and across New Year. Chunks that are all NaN aren't written, and S3 staging is checked against an in-memory fake.
- **The manifest:** the round-trip, refusing manifests that don't follow the spec, and a hash that stays stable across NaN payloads, memory layout and byte order.
- **CHC's request slot** (`test_lambda_handler.py`): taken and released by a run; HostBusy for a backfill month and a quiet end for a daily run while held; an expired slot taken over; a backfill execution's hold kept across its months, kept through a failed month, busy for others and another execution, released at the end (only its own, its reservation too), taken over once expired; the reservation of the next turn; the same on a `file://` copy; the `hold` and `release_hold` events.
- **The handler:** a fixtures-mode run from start to finish, a re-run that is one 304, the variants through the environment, a retry after a crash between the chunk upload and the manifest, a gap in the months that holds `finalThrough` back, a file whose days aren't its month's, and an image whose COPY line lacks a module.
- **The finals job** (`test_chirps_final.py`): the listing parser, a new month, a rewrite with the same values (no bump), a rewrite with changed values (a bump and its `changes`), the 304, a 403 that stops with no retry, the time budget, the pacing (within and across runs, on a fake clock), a backfill of a named month, the lease (local and S3), and the metric on every exit.
- **IMERG Late** (`test_imerg.py`): a known cell of a synthetic *global* file in IMERG's layout lands at its lat/lon (neighbours east and north, the region's four corners, nothing from outside), the whole region cell by cell, an OPeNDAP subset reading the same as the global file, a north-first (lat, lon) file still placed by coordinate, the units (mm/day read as the day's mm; mm/hr, V06's `precipitationCal`, the wrong day, 2500 mm and a login page refused), the CMR search (the newest version wins, a missing OPeNDAP link or a wrong time stops), the last 10 days newest first, held days skipped with no request, a gap (not held, `prelimThrough` still the newest day, and one older than the 10-day search blocking no later day), the time budget, keeping 30 days (manifest and chunks), the per-day version (V08 replacing V07 with and without a change of values), a 403 or 401 from either host stopping with the same-day marker, the lease (local and S3), the metric on every exit, and the token read from Secrets Manager and sent only to OPeNDAP, never on a redirect.
- **ERA5-Land** (`test_era5land.py`): each 00 UTC step as the day before's total, m to mm, the record's first day, the four-corner remap (inland and coastal), packing noise and a real negative, the 2000 mm bound, the phase from `expver`; a known cell and day at its array index and chunk; submit on one run and collect on a later one, one submit per month however often it runs, a held month never requested again, the gap after the newest held month, state lost while queued (adopted, not resubmitted), an intent without an id, state lost after collecting, a failed request's 1/2/4/8-day backoff and the loud stop after 5, the in-flight cap and the queue it drains; a re-check with the same values (no bump), with changed values (a bump with its `changes`), one still preliminary, and one with no `expver` (asked again every 30 days, up to the 180-day cap, and no more once a read says consolidated); a 401 and a 403 that stop the run and the rest of the UTC day; `LiveCds`'s 401/403/404/5xx mapping; the lease; the metric on every exit; the key read by ARN and not at all when no CDS call is needed; and the event through `lambda_handler.py`. The CDS is `fakecds.FakeCds`; nothing touches the network or needs a key.
- **AgERA5** (`test_agera5.py`): a zip of daily files and one NetCDF, x.x5 cells taken as they are and x.x0 points remapped, cells placed by coordinate (north-first files), the month's own days (a missing day refused), units (another unit refused), the 30 mm bound, packing noise and a real negative; the request's shape and recognising it; the events and the backfill's bounds; submit then collect into the finals (year from 1979, the cell, the credit); a re-check with the same values (no bump) and changed values (a bump with its `changes`), the recheck's cap; a 403/401 silencing the day; the metric on every exit; the manifest's URL and coverage rules. The CDS is `fakecds.FakeAgera5Cds`.
- **C3S seasonal** (`test_c3s_seasonal.py`): the 1° grid (D1 snapped outward, whole-degree centres) and the manifest's step; a request names its key back, someone else's doesn't; the release days (the 6th for ECMWF, the 10th for the rest, after 12 UTC plus the margin); the GRIB reader (de-accumulation to mm/day against the fixture's days, south-up, any lead count padded with NaN, a missing field leaving the two days it bounds NaN, packing noise clamped, a real drop or a flood refused, another request's file and a field twice refused, a hindcast's years); submit on one run and collect on a later one (four queued, nothing downloaded on the first run, a slow request, done means asked for nothing), the array (systems, members padded to the largest, the credit, the licence and the centres), the manifests and index, a re-collected forecast with other values (one revision), the catch-up bound; a failed request's backoff and the loud stop, a 403 silencing the day, a lost state adopting the queued request; the events; a hindcast backfill for one system and for all; the manifest's URL rules; the handler's routing, the lag on a failure, and the credit matching the engine's. The CDS is `fakecds.FakeC3sCds`.
- **NEX-GDDP-CMIP6** (`test_cmip6_delta.py`): the calendars (days and hours since an epoch, noon steps, `noleap`, `all_leap`, `360_day`; unknown ones refused); the cut of D1 (only the land cells, the south-west cell at [0, 0], the implausible margin never read, a north-first file placed by coordinate); the aggregation (a month's total in mm and mean in °C against the fixture's own daily formula, a leap February, a noleap February, a 360-day December, a missing day making that cell's month NaN); the refusals (units, packing, another step, an axis short of D1, cells off the 0.25° lattice, another year, a day short, an unknown calendar, a missing variable, a day above 2000 mm or below zero, an implausible temperature, tasmin above tasmax), round-off below zero clamped; the plan (the highest version, a stray file ignored, a missing file stopping the copy before any read, two variants needing a pin); the copy (arrays, shapes, chunks, attributes, a known cell at its year index, only land chunks written, the v1.1 values, the manifest's version, size and hash, each `license` attribute verbatim including the old licence and a missing one, the summary's licence counts, the index); a rerun reading nothing, `--recheck`, a run cut short resuming; a new version with the same values (no bump) and with other values (a revision, its change, the cells and the largest difference), a change over values the copy no longer holds claiming every cell; a product never mixing variants or calendars; S3 on both sides (ranged reads only, the ETag and date kept, a staged S3 copy); the range file's cache; the cmip6 manifest rules; the command; not in the image; and the committed `backend/fixtures/mirror/cmip6/` (backend/scripts/cmip6-fixture.ts) against this writer's layout, words, files, licence attributes and hashes.
- **FAO-56** (`test_fao56.py`): Example 8's Ra, Example 18's Ra, Rn and ET₀ (3.9 mm/day, from ea and from a dew point), eq. 7 both ways, e°, and NaN and no negative through the arrays.
- **PenPan** (`test_penpan.py`): McMahon et al. (2013) Worked examples 1, 2 and 9 (Alice Springs, 20 July 1980: the intermediate values, P_rad, f_dir, Rs,pan, f_pan, Rnl and 2.2570 + 1.4027 = 3.6597 mm/day, which S19.90 misprints as 3.6587; S6.1 also worked by hand from the printed intermediates), Thom's function in SI units, FAO-56 eq. 47, f_dir's bounds, NaN in NaN out, no negative, a month as its steady-state day × its days, the screen factor, and wind, dry air and sun each raising it.
- **The modelled pan grid** (`test_apan_grid.py`, against `power_fixture.FakePower`): one request per parameter, tile and year, the monthly means at a known point (a leap February), a reduced year not asked again, a missing day nulling the month, a 403 stopping the fetch; the `apan` form labelled modelled, every 0.1° centre in the box, a cell as its nearest point's PenPan averaged over the years in water-year order, screen and albedo recorded, a point missing a month left out, a gap or a repeated year refused, an implausible month refused; validation at a known ratio (bias and RMSE by month), a station outside the grid listed, the report from `fixtures/apan/stations.synthetic.csv` (invented stations); the commands end to end; and the committed `fixtures/apan/penpan.synthetic.json` (which `backend/src/geo/penpanGrid.test.ts` reads) against its generator (`test_apan_grid.py --write-fixture`).
- **NASA POWER** (`test_nasapower.py`): the tiles, one parameter a request in AG/JSON/LST, the JSON parser (fill and days not yet published NaN, units checked, other shapes refused), nearest-point placement and cells beyond the points NaN, a non-lattice refused, a run end to end (72 requests, ET₀ at a known cell equal to `fao56` of its point), a day POWER lacks skipped, the revision rule (25 cells changed for one point), the 120-day window, an implausible ET₀ and a deadline writing nothing, a 403/401 silencing the day, the metric on every exit, and the handler's routing.
- **The round trip** (`test_roundtrip.py`): Python writes the copy from the synthetic NetCDF, and Node's `backend/src/mirror/` reads it through `tests/roundtrip.ts`, bit for bit, with the same hash and manifest; `agera5_et0` and `power_et0` are read back whole the same way (the `blocks` mode). It needs the pnpm install (`backend/node_modules/.bin/tsx`) and skips without it, except in CI, where `INGEST_REQUIRE_NODE=1` makes it fail.
- **The ECMWF job** (`test_ecmwf_forecast.py`): the index filter (only the members' `tp`, sorted, the ranges being the messages), refusals (another run or step, a member twice, the wrong field), the corner mean at 0.1° on a structured field (and one wet point shared by its four cells), longitudes that wrap, de-accumulation to daily mm (round-off, a drop, over 2000 mm, a gap), the statistics, a fixtures run end to end (the array, its metadata, the manifest, the index, the request count), the time budget and the resumed run, keeping 7 and archiving the rest as their mean, a 403 that stops with no retry, writes the marker and silences the day, the lease, the metric on every exit, a partial issue never listed, the sweep, the S3 path, the handler's routing, the image's COPY lines and the committed fixture against its generator.
- **The fit** (`test_ecmwf_qm_fit.py`, synthetic data only): a doubled forecast mapped back, identity, the rule beyond the pairs (the same vectors as the Node side's `applyQm`), seasons, and a fit from a small synthetic copy with its provenance.
- **Module names** (`test_module_names.py`): no module of ours (ingest/, the fixture helpers) shares a name with an installed requirement's top-level package or with the stdlib, and laid out flat as the image lays them out, `import ecmwf` is not ours and `from ecmwf.datastores import Client` resolves (with a control: an `ecmwf.py` beside them breaks it). The ECMWF job was once `ecmwf.py` and shadowed ecmwf-datastores-client's `ecmwf` package in the image, so every CDS-backed run failed in production while fixtures-mode tests, which never build the real client, passed.
- **The reader:** a value outside 0–2000 mm fails the read and writes nothing.
- **The fixture:** it still matches its generator.
- **The copy's verification** (`test_verify_copy.py`): `tiffread.py` against synthetic GeoTIFFs written by the test (LZW in TIFF's early-change variant, deflate and none; one and several rows per strip; both byte orders; every pixel, no data included), with the formats it refuses. Sampling is seeded and stratified across products and years. The CHC check runs against a fake CHC serving TIFFs of a `zarrstore`-written copy: a pass at one request a second, a one-ulp mismatch failing with both values, a 404 and a 403 that stops after one request. The dynamical.org comparison runs on synthetic arrays: the units, the row flip, the mask, the tolerance and dry cells, with `main` reading the region from the copy against a fake store. The coverage check covers a gap, the first month, `finalThrough` and the lag, plus the committed fixture copy offline. Nothing touches CHC or dynamical.org.

CI runs them in the `ingest` job, "Bulk ingest (Python)", in
`.github/workflows/ci.yml`, with Node and the pnpm install for the round
trip. That job feeds into `CI gate`.

## The fixtures

`fixtures/chirps/` is the synthetic `byMonth` directory the finals job and
fixtures mode read: January and February 2024 (the last three days of each,
to stay small), `listing.html`, and two variants of February with their
listings: `rewritten/` (the same values in other bytes, as CHC re-copying a
file) and `changed/` (two cells changed). Each listing's sizes are the files'
real sizes. Regenerate them with
`ingest/.venv/bin/python ingest/fixtures/chirps/make_chirps_fixtures.py` and
commit the result; a test fails if they drift from the generator.

`fixtures/apan/` holds the modelled pan grid's synthetic files:
`penpan.synthetic.json`, `apan_grid.py`'s output for 2020 from
`power_fixture.FakePower`'s invented weather (regenerate with
`ingest/.venv/bin/python ingest/test_apan_grid.py --write-fixture`; a test
fails if it drifts, and the backend's `penpanGrid.test.ts` reads it), and
`stations.synthetic.csv`, three invented Class-A pan "stations" (`SYN-PAN-n`,
made-up values, the third outside the tests' box on purpose).

`fixtures/imerg/make_imerg_fixture.py` writes IMERG Late daily files in
GPM_3IMERGDL V07's layout for any day, from an invented field that differs
between neighbouring cells in both directions and between days (so a
transposed or flipped read can't pass), with a block of fill inside the
region. Nothing is committed but the script: the tests and the fake server
write what they need (`ingest/.venv/bin/python ingest/fixtures/imerg/make_imerg_fixture.py <dir> [YYYY-MM-DD]`
writes one global file, ~3 MB).

`fixtures/chc/chirps-v3.0.2024.02.days_p05.nc` is the reader's fixture, also invented. It covers
2024-02-27 to 2024-02-29 (so the leap day is included) over the region plus a
10-cell margin, in CHC's real layout from the Round 0 spike:

- `precip(time, latitude, longitude)`, float32, with `-9999` as both `_FillValue` and `missing_value`;
- latitude ascending, with float32 coordinates;
- `time` as float32 "days since 1980-1-1";
- gzip level 5.

The land is two rectangles plus the south-west corner cell. Everything else
is sea. To regenerate it after changing the generator, run this and commit
the result:

```sh
ingest/.venv/bin/python ingest/fixtures/make_chc_fixture.py
```

`fixtures/cmip6/make_cmip6_fixture.py` writes the synthetic NEX-GDDP-CMIP6
tree: models `SYN-A` (`proleptic_gregorian`, latitude south first), `SYN-B`
(`noleap`, north first, variant `r1i1p1f2`) and `SYN-C` (`360_day`, hours
since the epoch), each with historical 2013–2014 and both SSPs in 2036 and
2066, on axes one cell wider than D1 each way; a few land cells (a 4 × 4
block round 33.5° S, 21.5° E and D1's south-west cell) and two margin cells
with implausible values the cut must drop; SYN-A's ssp245 tasmax 2036 also
as a warmer `_v1.1`, one missing day in SYN-B's ssp585 tasmin 2066, SYN-C's
historical files saying CC BY-SA 4.0 and its ssp585 pr 2066 with no
`license`. Unallocated HDF5 chunks keep each file a few kB (1.7 MB in all).
Nothing is committed but the script (`ingest/.venv/bin/python ingest/fixtures/cmip6/make_cmip6_fixture.py <dir>`).
The backend's committed copy holds its own invented aggregates for the same
models (`backend/scripts/cmip6-fixture.ts`).

`fixtures/ecmwf/` holds one invented ECMWF issue, 15 step files with their
`.index`, on ECMWF's real 0.1° global grid, 4 members each with a 2 m
temperature field between their `tp` fields. Each field is constant (GRIB
packs a constant in no bits, so a file is about 1.5 KB); the tests write
their own structured fields. Regenerate with
`ingest/.venv/bin/python ingest/fixtures/ecmwf/make_ecmwf_fixtures.py`; a
test fails if they drift.

`fixtures/c3s/make_c3s_fixture.py` writes C3S seasonal requests' GRIB2 for
any key (`fc/<system>/YYYY-MM` or `hc/<system>/MM`) from an invented daily
pattern (`daily_mm`, 0–11 mm in 0.5 mm steps, different by system, member,
year, day and cell), accumulated per start as the CDS gives it. Nothing is
committed but the script: `FakeC3sCds` writes each download (2 members, 3
for ECMWF, every lead, the first three hindcast years by default; the tests
ask for 5 leads), and `ingest/.venv/bin/python ingest/fixtures/c3s/make_c3s_fixture.py fc/ecmwf-51/2026-10 out.grib`
writes one by hand.

## The image

```sh
docker buildx build --platform linux/arm64 -f ingest/Dockerfile ingest
```

- **Base:** AWS's Lambda Python 3.14 image, using the arm64 tag pinned by
  digest.
- **User:** `USER 65534` (nobody), so the image never runs as root (Trivy
  DS-0002; `test_lambda_handler.py` checks it). Lambda runs it as its own
  unprivileged user anyway; this covers a local `docker run`. The code and
  packages are world-readable and the job writes only to `/tmp`.
- **Pin checks:** `pnpm check:pins` refuses a `FROM` that isn't
  `public.ecr.aws/lambda/python:<version>-arm64@sha256:…`, and a
  `pip install` without `--require-hashes`.
- **Moving the digest:** look it up with
  `docker buildx imagetools inspect public.ecr.aws/lambda/python:3.14-arm64`.
  Dependabot's docker entry for `/ingest` proposes the same move.
- **Python dependencies:** they move through Dependabot's pip entry for
  `/ingest`, and `requirements.txt`'s header explains how to regenerate the
  hashes by hand.

The image ships only the job's modules: no tests and no fixtures. They are copied flat into `/var/task`, first on the Lambda's `sys.path`, so a module named like an installed package's top level (`ecmwf`, `zarr`, `requests`, …) shadows it; `test_module_names.py` refuses one.
