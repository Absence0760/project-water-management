# Spike: issue #604 Round 0 (our own copy of CHIRPS)

Run 2026-10-26/27 from the dev workstation, before anything in Rounds 1–3 is
built. Round 0 checks five assumptions in the
[#604 plan](https://github.com/Absence0760/project-water-management/issues/604).
The scripts are in [`604-round0/`](./604-round0/). They are kept to reproduce
the results, are not part of the app and are not run by CI.

**Requests made to CHC in total:** 3 directory listings, 1 whole NetCDF
download and 28 range reads of 4 daily TIFFs, paced at 1 a second with the
feeds' User-Agent. No 403s. dynamical.org was read anonymously from its AWS
Open Data bucket, which puts no load on CHC.

## Results

| # | Question | Answer | What it changes in the plan |
|---|---|---|---|
| 1 | What does a CHC `byMonth` `rnl` NetCDF store, and are its values bit-equal to the daily TIFFs'? | **float32, no `scale_factor`/`add_offset`, bit-equal 20/20.** | D2 and D4 hold as written. The ≈1,800 cached cell-days need no revision. |
| 2 | Does `final/sat/netcdf/byMonth/` exist with the same layout? | **Yes**: 316 files, `chirps-v3.0.YYYY.MM.days_p05.nc`, from 2000-06 to 2026-09 (`rnl`: 549 files, 1981-01 to 2026-09). | `sat` uses the same code path as `rnl`, with a 2000-06 start. |
| 3 | How far are dynamical.org's values from CHC's? | Over the whole D1 box for June 2024: **median 0.067%, p99 0.17%, max 0.195%** on wet cell-days, and the same land/sea mask. | D5's "≤0.2%" is confirmed and becomes R3-E's tolerance. Its units are kg m⁻² s⁻¹, so multiply by 86,400. |
| 4 | How long does a ≈330 MiB download from CHC take from af-south-1? | **Not yet run** (it needs the operator's console). From the workstation: 346 MiB in 25.6 s (14.2 MB/s). | See [Check 4](#4-download-time-from-af-south-1). |
| 5 | Does zarrita.js (exact pin) in Node 24 read a zarr-python v3 float32 gzip array with the D2 chunking? | **Reading: yes**, bit-equal, both layouts. **Writing: zarrita 0.7.5 cannot encode gzip**, but a small `node:zlib` codec registered with `zarr.registry` works, and zarr-python reads what it writes bit for bit. | R1-C needs that codec for `gen:mirror-fixture` (see below). The raw-float32 fallback is not needed. |

### 1. The NetCDF's format

`chirps-v3.0.2024.06.days_p05.nc` (`inspect_nc.py`, which uses h5py; no
`ncdump` is installed here, and h5py reports the same storage facts):

- HTTP: `content-length: 362853441` (346.0 MiB), `last-modified: Wed, 27 May 2026 18:19:55 GMT`, `etag: "6a1735cb-15a0b441"`, `accept-ranges: bytes`. That's nginx's ETag (mtime-size in hex), so D8's (mtime, size, ETag) carries no more information than mtime + size.
- NetCDF-4 / HDF5 (`netcdf=4.9.2, hdf5=1.10.5`), CF-1.6.
- `precip(time=30, latitude=2400, longitude=7200)`, **float32**, `_FillValue = missing_value = -9999`, **no `scale_factor` or `add_offset`**, units `mm/day`.
- HDF5 chunks **(5, 480, 1440)**, **gzip level 5**, no shuffle. Only 150 chunks are stored (all-sea chunks are left out).
- `latitude` runs **south to north** (−59.975 → 59.975), unlike the TIFFs' north-up rows. Coordinates are float32 (`10.024994`, not `10.025`), so the reader must compute grid indices from the origin and step, not match coordinate values.
- `time` is float32 "days since 1980-1-1" (16223 = 2024-06-01).

**Bit-equality** (`pick.py`, then the backend's own TIFF reader
`gridValuesTagged` on `chirpsRnlUrl(day)`): 5 Western Cape cells × 4 days
(the three wettest days of the month and one dry one) = 20 cell-days, every
one with the same float32 bits in the NetCDF and the TIFF, zeros included.
The TIFF reader made 28 range requests for 4 files, which is the "about 5
requests a file" #604 counts on.

**The D1 box in this file:** 550 × 620 = 341,000 cells a day, matching D1.
In June 2024, 3.48 M of the 10.2 M cell-days are fill (−9999, the sea), with
no NaN, no other negative value, and a maximum of 87.0 mm. The copy
stores fill as NaN, which the cache already reads as no data.

**Range reads are possible but not needed:** 24 of the 150 HDF5 chunks
(48.8 MiB of 346 MiB) cover the D1 box. A range-reading backfill could fetch
about 7× fewer bytes but would make about 30 requests a month instead of 1.
D4's whole-file download stays the choice, since request count is what gets
us banned.

### 3. dynamical.org against CHC

`dyn.py` reads the same 20 cell-days and `dynbox.py` reads the whole D1 box for
June 2024 (30 × 550 × 620, 6.7 s from the workstation) from
`s3://dynamical-ucsb-chc-chirps/ucsb-chc-chirps-analysis-final/v0.1.0.icechunk`
(icechunk 2.3.0, xarray 2026.9.0):

- Variable `precipitation_surface`, float32, **kg m⁻² s⁻¹** (mm/s): multiply by 86,400 to compare. Latitude is north-up. Inner chunks (365, 60, 60), shards (365, 1200, 1800), Blosc zstd level 3 with shuffle.
- The land/sea mask matches exactly (NaN where CHC has −9999).
- 3.09 M of 6.75 M land cell-days are exactly equal (nearly all zeros). On the 363,775 wet cell-days (≥ 1 mm): relative difference **median 0.067%, p99 0.174%, max 0.195%**. Largest absolute difference 0.15 mm. The box total differs by 0.00006%.
- That is the 8-mantissa-bit rounding D5 describes. It's fine for a cross-check, but values never bit-match, which is why D10 keeps it out of the cache.

### 4. Download time from af-south-1

Not run in this session: it needs the operator's AWS console, and running it
through a Lambda would mean deploying one. AWS CloudShell is offered in
Africa (Cape Town), so the operator runs one command there. The command is
in the PR description. It downloads the same file to `/dev/null` (one
request) and prints the status code, size and time.

- A **200** in under about 5 minutes confirms D11's 15-minute Lambda budget with room to spare. The workstation took 26 s.
- A **403** is also an answer: CHC bans AWS af-south-1 addresses even for one request, so D12's trigger (a fixed address CHC allowlists) applies before R2-A ships. CloudShell's address isn't a Lambda's, but both are AWS af-south-1 egress.

### 5. zarrita.js

`write_zarr.py` (zarr 3.4.1, numpy 2.5.4) writes the June 2024 box in both D2
layouts:

- finals `rnl`: (year=2, doy=366, lat=550, lon=620), chunk (1, 366, 20, 20), float32, gzip 6, fill NaN;
- daily `prelim`: (day=30, lat=550, lon=620), chunk (1, 110, 124).

`read.mjs` reads them with **zarrita 0.7.5** (`@zarrita/storage` 0.2.0,
`numcodecs` 0.3.2, exact pins) and `FileSystemStore` on Node 24.15:

- 7 probe cells (3 land, 4 sea, including chunk corners 19/20 and the last cell): **bit-equal** in both layouts, NaN where the sea is.
- A chunk zarr-python never wrote (it skips all-fill chunks, so year 0 has no objects) reads as the fill value. R1-C's reader can rely on that, and so can the D2 storage estimate.
- A 10 × 10-cell block for a whole year (one D3 job) reads in 35–90 ms from local disk.
- **Writing:** `zarr.create` plus `zarr.set` with the `gzip` codec throws `UnsupportedError: gzip encode`, because zarrita 0.7.5's gzip codec only decodes. Registering a 10-line codec over `node:zlib` (`zarr.registry.set('gzip', …)`, in `read.mjs` behind `NODE_GZIP=1`) fixes it, and zarr-python reads the zarrita-written chunk bit-equal, with the unwritten chunk as NaN.

**For R1-C:** `backend/src/mirror/` registers that `node:zlib` gzip codec
before any write and tests that a write followed by a read round-trips.
Production reads need no change, since decoding works out of the box.

**Size:** the finals array for June 2024 (11 months of it NaN) is 9.5 MB and
the 30-day daily array is 15 MB. Twelve wet-season months a year would come
to roughly 110–180 MB a year, about 5–8 GB for 1981→. That's in line with
D1's 5–7 GB estimate, from one month's sample, so it's indicative only.

## Reproducing

```bash
python3 -m venv venv && ./venv/bin/pip install numpy h5py xarray h5netcdf zarr icechunk
curl -A 'water-management-feeds/1 (+https://github.com/Absence0760/project-water-management)' -O https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/rnl/netcdf/byMonth/chirps-v3.0.2024.06.days_p05.nc
./venv/bin/python -I inspect_nc.py chirps-v3.0.2024.06.days_p05.nc
./venv/bin/python -I pick.py chirps-v3.0.2024.06.days_p05.nc picked.json   # the 20 cell-days
./venv/bin/python -I dyn.py picked.json dyn.json && ./venv/bin/python -I dynbox.py chirps-v3.0.2024.06.days_p05.nc
./venv/bin/python -I write_zarr.py chirps-v3.0.2024.06.days_p05.nc store.zarr && NODE_GZIP=1 node read.mjs store.zarr
```

The TIFF side of check 1 ran as a throwaway `tsx` script inside `backend/`
(deleted afterwards). For each day in `picked.json` it calls
`gridValuesTagged(liveHttp(), chirpsRnlUrl(day), cells)` with a 1-second
pause before each range read, and compares the float32 bits with the
NetCDF's.
