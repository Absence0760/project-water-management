# Bulk ingest job

The scheduled job that copies upstream rain data into **our own copy**, so the
app never fetches from someone else's server because a feed or a user asked
(issue #604, "The rule"). Python 3.14, run as an arm64 container-image Lambda
(D11), since NetCDF/HDF5 has no good Node reader. The daily TIFF and DWS
ingest stay in Node (`backend/`).

Round 1 built the skeleton (the writer, the manifest, the polite client, the
image and CI); Round 2 (R2-A) added the CHIRPS finals job, `chirps_final.py`,
which lists CHC's `byMonth` directories and copies new or rewritten months.
Fixtures mode runs the same code against a synthetic directory.

| File | What it does |
| --- | --- |
| `lambda_handler.py` | `handler(event, context)`: validates the event, runs the finals job, and publishes `MirrorLagDays` on every exit. |
| `chirps_final.py` | The CHIRPS finals job (below): the listing and its diff, paced whole-file downloads within the time budget, and `ingest_file`, the single-file path. |
| `cloudwatch.py` | The freshness metric `MirrorLagDays` (CloudWatch live, a local sink in fixtures mode). |
| `lease.py` | One writer per product: a lease object taken with S3 conditional writes. |
| `fixturehttp.py` | Fixtures mode's stand-in for CHC's server over `fixtures/chirps/`. Not in the image. |
| `polite.py` | The one HTTP client (below). |
| `zarrstore.py` | The Zarr v3 writer for both D2 layouts, against a local directory or S3. |
| `manifest.py` | `<product>/manifest.json`: read, write, validate, and `valuesSha256`. |
| `chcnetcdf.py` | Reads one CHC NetCDF file and cuts out the region (D1), refusing any other layout. |
| `grid.py` | The region, the grid and the index maths every module shares. |
| `fixtures/make_chc_fixture.py` | Writes `fixtures/chc/chirps-v3.0.2024.02.days_p05.nc`, the reader's synthetic fixture. |
| `fixtures/chirps/make_chirps_fixtures.py` | Writes the synthetic `byMonth` directory (`fixtures/chirps/`): two months, their listing, and a rewritten and a changed variant. |
| `tests/roundtrip.ts` | The Node half of the cross-language round trip (`test_roundtrip.py`). |
| `Dockerfile` | The Lambda image (build context `ingest/`). |
| `dev.sh` | `pnpm dev:ingest:run` and `pnpm test:ingest`. |

## The event and the environment

```json
{ "product": "rnl" | "sat", "mode": "monthly" }
{ "product": "rnl" | "sat", "mode": "backfill", "month": "YYYY-MM" }
```

A backfill names its month (from 1981-01 for `rnl`, 2000-06 for `sat`); a
monthly run takes none. Any other key is refused.

| Variable | Meaning |
| --- | --- |
| `MIRROR_URL` | Required. `file:///abs/path` locally, `s3://<bucket>[/prefix]` in production. |
| `FEED_SOURCE` | `fixtures` (the default: the synthetic `byMonth` directory, no network) or `live` (production: CHC). |
| `INGEST_CONTACT` | The contact address in the User-Agent. Optional. |
| `INGEST_FIXTURE_VARIANT` | Fixtures mode only: `rewritten` or `changed` serves that variant of the synthetic directory. |
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
- **429 and 503:** it waits as long as `Retry-After` asks, given in seconds or as an HTTP date. It retries at most `max_retries` times and gives up (`RetryLater`) rather than wait longer than `max_wait`.
- **403:** it raises `StopRun` at once, with no retry. The run stops and the alarm fires, because CHC bans by volume.

## Run it locally

Optional, like `gen:help-art`: `pnpm dev`, e2e and the other CI jobs never
need Python. Each command creates `ingest/.venv` (gitignored) from the
hash-pinned `requirements.txt` the first time it runs, and again whenever that
file changes.

```sh
pnpm dev:ingest:run          # rnl into ingest/.mirror (gitignored); `pnpm dev:ingest:run sat` for sat
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
- **The round trip** (`test_roundtrip.py`): Python writes the copy from the synthetic NetCDF, and Node's `backend/src/mirror/` reads it through `tests/roundtrip.ts`, bit for bit, with the same hash and manifest. It needs the pnpm install (`backend/node_modules/.bin/tsx`) and skips without it, except in CI, where `INGEST_REQUIRE_NODE=1` makes it fail.
- **The reader:** a value outside 0–2000 mm fails the read and writes nothing.
- **The fixture:** it still matches its generator.

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
