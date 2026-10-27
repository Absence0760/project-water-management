# Bulk ingest job

The scheduled job that copies upstream rain data into **our own copy**, so the
app never fetches from someone else's server because a feed or a user asked
(issue #604, "The rule"). Python 3.14, run as an arm64 container-image Lambda
(D11), since NetCDF/HDF5 has no good Node reader. The daily TIFF and DWS
ingest stay in Node (`backend/`).

Round 1 is the skeleton: the modules below, a fixtures mode that runs end to
end without a network, the image and CI. Listing and downloading CHC's
`byMonth` files (R2-A, `chirps_final.py`) comes next, so `FEED_SOURCE=live`
refuses for now.

| File | What it does |
| --- | --- |
| `lambda_handler.py` | `handler(event, context)`: validates the event, reads the source, writes the copy and the manifest. |
| `polite.py` | The one HTTP client (below). |
| `zarrstore.py` | The Zarr v3 writer for both D2 layouts, against a local directory or S3. |
| `manifest.py` | `<product>/manifest.json`: read, write, validate, and `valuesSha256`. |
| `chcnetcdf.py` | Reads one CHC NetCDF file and cuts out the region (D1), refusing any other layout. |
| `grid.py` | The region, the grid and the index maths every module shares. |
| `backfill_plan.py` | Prints the backfill state machine's month list (`infra/ingest_backfill.tf`), skipping months the manifest holds. Standard library only. Runbook: docs/deployment.md § Backfill. |
| `fixtures/make_chc_fixture.py` | Writes `fixtures/chc/chirps-v3.0.2024.02.days_p05.nc`, the synthetic fixture. |
| `Dockerfile` | The Lambda image (build context `ingest/`). |
| `dev.sh` | `pnpm dev:ingest:run` and `pnpm test:ingest`. |

## The event and the environment

```json
{ "product": "rnl" | "sat", "mode": "monthly" | "backfill", "month": "YYYY-MM" }
```

`month` is optional. Any other key is refused.

| Variable | Meaning |
| --- | --- |
| `MIRROR_URL` | Required. `file:///abs/path` locally, `s3://<bucket>[/prefix]` in production. |
| `FEED_SOURCE` | `fixtures` (the default: the committed synthetic NetCDF, no network) or `live` (production). |
| `INGEST_CONTACT` | The contact address in the User-Agent. Optional. |

In fixtures mode, `monthly` copies the fixture for `month` (or the newest
fixture when `month` is absent), and `backfill` copies every fixture file.

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
- **The handler:** a fixtures-mode run from start to finish, a re-run that changes nothing, a rewrite that bumps the revision, a retry after a crash between the chunk upload and the manifest, a gap in the months that holds `finalThrough` back, and a file whose days aren't its month's.
- **The reader:** a value outside 0–2000 mm fails the read and writes nothing.
- **The fixture:** it still matches its generator.

CI runs them in the `ingest` job, "Bulk ingest (Python)", in
`.github/workflows/ci.yml`. That job feeds into `CI gate`.

## The fixture

`fixtures/chc/chirps-v3.0.2024.02.days_p05.nc` is invented. It covers
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
