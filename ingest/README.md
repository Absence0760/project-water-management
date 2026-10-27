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
one.

| File | What it does |
| --- | --- |
| `lambda_handler.py` | `handler(event, context)`: validates the event, runs the finals job, and publishes `MirrorLagDays` on every exit. |
| `chirps_final.py` | The CHIRPS finals job (below): the listing and its diff, paced whole-file downloads within the time budget, and `ingest_file`, the single-file path. |
| `era5land.py` | The ERA5-Land job (§ The ERA5-Land job): submit a month's CDS request, collect it on a later run, the 0.1° remap, the revision rule, and its own handler (`lambda_handler.py` hands `era5l` events to it). |
| `fakecds.py` | Fixtures mode's stand-in for the CDS: submit, status, find and download, serving `fixtures/era5land/`'s synthetic NetCDF. Not in the image. |
| `requirements.a.in` | R4-A's direct dependency (`ecmwf-datastores-client`, the CDS client), to be hash-pinned into `requirements.txt` at the round's merge. |
| `cloudwatch.py` | The freshness metric `MirrorLagDays` (CloudWatch live, a local sink in fixtures mode). |
| `lease.py` | One writer per product: a lease object taken with S3 conditional writes. |
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
| `fixtures/chirps/make_chirps_fixtures.py` | Writes the synthetic `byMonth` directory (`fixtures/chirps/`): two months, their listing, and a rewritten and a changed variant. |
| `tests/roundtrip.ts` | The Node half of the cross-language round trip (`test_roundtrip.py`). |
| `Dockerfile` | The Lambda image (build context `ingest/`). |
| `dev.sh` | `pnpm dev:ingest:run`, `pnpm test:ingest` and `ingest/dev.sh verify`. |

## The event and the environment

```json
{ "product": "rnl" | "sat", "mode": "monthly" }
{ "product": "rnl" | "sat", "mode": "backfill", "month": "YYYY-MM" }
{ "product": "era5l", "mode": "monthly" }
{ "product": "era5l", "mode": "backfill", "month": "YYYY-MM" }
```

A backfill names its month (from 1981-01 for `rnl`, 2000-06 for `sat`); a
monthly run takes none. Any other key is refused. An `era5l` backfill
names a month from 1950-01 to the newest complete one.

| Variable | Meaning |
| --- | --- |
| `MIRROR_URL` | Required. `file:///abs/path` locally, `s3://<bucket>[/prefix]` in production. |
| `FEED_SOURCE` | `fixtures` (the default: the synthetic `byMonth` directory, no network) or `live` (production: CHC). |
| `INGEST_CONTACT` | The contact address in the User-Agent. Optional. |
| `INGEST_FIXTURE_VARIANT` | Fixtures mode only: `rewritten` or `changed` serves that variant of the synthetic directory. |
| `CDS_KEY_SECRET_ARN` | Live `era5l` runs only: the Secrets Manager secret holding the CDS API key (`infra/era5land.tf`), read at run time and never logged. Fixtures mode never reads it. |
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
  the end of the contiguous run of months held (ERA5-Land-T days included:
  a revision later marks them, as below).
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
  days after it ends, then every 30 days while still preliminary. CHIRPS's
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
pnpm test:ingest             # the unittest suite
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

- **The polite client:** pacing, the 304 skip, the 403 stop, and `Retry-After` given in seconds or as a date. They run against a fake opener and clock, so nothing touches the network or sleeps.
- **The writer:** the exact D2 metadata, and where a known cell-day lands, for leap and non-leap years and across New Year. Chunks that are all NaN aren't written, and S3 staging is checked against an in-memory fake.
- **The manifest:** the round-trip, refusing manifests that don't follow the spec, and a hash that stays stable across NaN payloads, memory layout and byte order.
- **The handler:** a fixtures-mode run from start to finish, a re-run that is one 304, the variants through the environment, a retry after a crash between the chunk upload and the manifest, a gap in the months that holds `finalThrough` back, a file whose days aren't its month's, and an image whose COPY line lacks a module.
- **The finals job** (`test_chirps_final.py`): the listing parser, a new month, a rewrite with the same values (no bump), a rewrite with changed values (a bump and its `changes`), the 304, a 403 that stops with no retry, the time budget, the pacing (within and across runs, on a fake clock), a backfill of a named month, the lease (local and S3), and the metric on every exit.
- **ERA5-Land** (`test_era5land.py`): each 00 UTC step as the day before's total, m to mm, the record's first day, the four-corner remap (inland and coastal), packing noise and a real negative, the 2000 mm bound, the phase from `expver`; a known cell and day at its array index and chunk; submit on one run and collect on a later one, one submit per month however often it runs, a held month never requested again, the gap after the newest held month, state lost while queued (adopted, not resubmitted), an intent without an id, state lost after collecting, a failed request's 1/2/4/8-day backoff and the loud stop after 5, the in-flight cap and the queue it drains; a re-check with the same values (no bump), with changed values (a bump with its `changes`), and one still preliminary; a 401 and a 403 that stop the run and the rest of the UTC day; `LiveCds`'s 401/403/404/5xx mapping; the lease; the metric on every exit; the key read by ARN and not at all when no CDS call is needed; and the event through `lambda_handler.py`. The CDS is `fakecds.FakeCds`; nothing touches the network or needs a key.
- **The round trip** (`test_roundtrip.py`): Python writes the copy from the synthetic NetCDF, and Node's `backend/src/mirror/` reads it through `tests/roundtrip.ts`, bit for bit, with the same hash and manifest. It needs the pnpm install (`backend/node_modules/.bin/tsx`) and skips without it, except in CI, where `INGEST_REQUIRE_NODE=1` makes it fail.
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

## The image

```sh
docker buildx build --platform linux/arm64 -f ingest/Dockerfile ingest
```

- **Base:** AWS's Lambda Python 3.14 image, using the arm64 tag pinned by
  digest.
- **Pin checks:** `pnpm check:pins` refuses a `FROM` that isn't
  `public.ecr.aws/lambda/python:<version>-arm64@sha256:…`, and a
  `pip install` without `--require-hashes`.
- **Moving the digest:** look it up with
  `docker buildx imagetools inspect public.ecr.aws/lambda/python:3.14-arm64`.
  Dependabot's docker entry for `/ingest` proposes the same move.
- **Python dependencies:** they move through Dependabot's pip entry for
  `/ingest`, and `requirements.txt`'s header explains how to regenerate the
  hashes by hand.

The image ships only the job's modules: no tests and no fixtures.
