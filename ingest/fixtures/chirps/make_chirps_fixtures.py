"""Write the synthetic CHC `byMonth` directory the finals job's tests and its
fixtures mode read (issue #604 R2-A).

    ingest/.venv/bin/python ingest/fixtures/chirps/make_chirps_fixtures.py [OUTDIR]

Invented values in CHC's real `byMonth` NetCDF layout (the same writer
conventions as ../make_chc_fixture.py: float32 `precip(time, latitude,
longitude)`, -9999 fill, latitude ascending, float32 coordinates, time as
float32 "days since 1980-1-1", the region plus a 10-cell margin). Each file
holds only the last three days of its month, to stay small; the job checks a
file runs to its month's last day, not that it starts on the 1st.

What it writes (no client or real data):

- `chirps-v3.0.2024.01.days_p05.nc`, `chirps-v3.0.2024.02.days_p05.nc`: two
  months, and `listing.html`, an nginx "fancy" index table listing them, as CHC serves it (with a
  parent link and a file that isn't a byMonth NetCDF, both ignored).
- `rewritten/chirps-v3.0.2024.02.days_p05.nc`: February written again with
  the **same values** but other HDF5 chunking and title, so its bytes, size
  and mtime differ (CHC re-copying a file), and `listing-rewritten.html`.
- `changed/chirps-v3.0.2024.02.days_p05.nc`: February with **changed
  values** (one cell +1.5 mm on 28 Feb, a sea cell that now has rain on the
  29th), and `listing-changed.html`.

`month_values()` says what each file holds, so the tests compare without
re-deriving it. Each listing's size column is the file's size rounded as
nginx's fancy index shows it, and its time (UTC, to the minute) is what fixturehttp.py serves as the
file's Last-Modified.
"""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent))
sys.path.insert(0, str(HERE.parent))

import grid  # noqa: E402
import make_chc_fixture as chc  # noqa: E402

DAYS = 3
EPOCH = dt.date(1980, 1, 1)
LISTING_PATH = "/products/CHIRPS/v3.0/daily/final/rnl/netcdf/byMonth/"

#: (year, month) → the day offset that makes its values differ from the other month's.
MONTHS = {(2024, 1): 5, (2024, 2): 0}

#: The listing's times (UTC, to the minute).
MTIME = {(2024, 1): dt.datetime(2024, 3, 18, 9, 41, tzinfo=dt.UTC), (2024, 2): dt.datetime(2024, 4, 17, 14, 5, tzinfo=dt.UTC)}
MTIME_REWRITTEN = dt.datetime(2026, 8, 3, 6, 12, tzinfo=dt.UTC)
#: A later rewrite with changed values. Its own time: CHC's fancy index rounds
#: sizes, so the listing tells two rewrites apart by their times alone.
MTIME_CHANGED = dt.datetime(2026, 9, 14, 8, 30, tzinfo=dt.UTC)

#: The changed variant: (day, row, col) → new value. Row 50/col 350 is land; row 500/col 600 is sea in the original.
CHANGES = {(1, 50, 350): None, (2, 500, 600): 7.5}
CHANGE_BUMP = 1.5


def name(year: int, month: int) -> str:
    return f"chirps-v3.0.{year:04d}.{month:02d}.days_p05.nc"


def first_day(year: int, month: int) -> dt.date:
    nxt = dt.date(year + month // 12, month % 12 + 1, 1)
    return nxt - dt.timedelta(days=DAYS)


def month_values(year: int, month: int, variant: str = "original") -> np.ndarray:
    """The region values (days, rows, cols) the file for that month holds, NaN for sea."""
    k = MONTHS[(year, month)]
    rows, cols = np.meshgrid(np.arange(grid.ROWS), np.arange(grid.COLS), indexing="ij")
    land = np.zeros((grid.ROWS, grid.COLS), dtype=bool)
    land[0, 0] = True
    land[40:140, 300:420] = True
    land[400:450, 20:90] = True
    out = np.full((DAYS, grid.ROWS, grid.COLS), np.nan, dtype=np.float32)
    for d in range(DAYS):
        v = (((rows * 7 + cols * 13 + (d + k) * 31) % 50) / 2).astype(np.float32)
        out[d][land] = v[land]
    if variant == "changed":
        assert (year, month) == (2024, 2)
        for (d, r, c), v in CHANGES.items():
            out[d, r, c] = out[d, r, c] + np.float32(CHANGE_BUMP) if v is None else np.float32(v)
    return out


def write_nc(path: Path, day0: dt.date, region: np.ndarray, chunks=(DAYS, 190, 320), title="Synthetic CHIRPS-like fixture") -> Path:
    import h5netcdf

    path.parent.mkdir(parents=True, exist_ok=True)
    days = region.shape[0]
    full = np.full((days, chc.NLAT, chc.NLON), -9999, dtype=np.float32)
    full[:, chc.MARGIN : chc.MARGIN + grid.ROWS, chc.MARGIN : chc.MARGIN + grid.COLS] = np.where(np.isnan(region), np.float32(-9999), region)
    with h5netcdf.File(path, "w") as f:
        f.attrs["Conventions"] = "CF-1.6"
        f.attrs["title"] = f"{title} (invented values; water-management ingest tests)"
        f.dimensions = {"time": days, "latitude": chc.NLAT, "longitude": chc.NLON}
        t = f.create_variable("time", ("time",), "f4")
        t[:] = np.array([(day0 - EPOCH).days + i for i in range(days)], dtype=np.float32)
        t.attrs["units"] = "days since 1980-1-1"
        t.attrs["calendar"] = "gregorian"
        lat = f.create_variable("latitude", ("latitude",), "f4")
        lat[:] = (chc.LAT0 + np.arange(chc.NLAT) * grid.STEP).astype(np.float32)
        lat.attrs["units"] = "degrees_north"
        lon = f.create_variable("longitude", ("longitude",), "f4")
        lon[:] = (chc.LON0 + np.arange(chc.NLON) * grid.STEP).astype(np.float32)
        lon.attrs["units"] = "degrees_east"
        p = f.create_variable("precip", ("time", "latitude", "longitude"), "f4", fillvalue=np.float32(-9999), compression="gzip", compression_opts=5, chunks=chunks)
        p[:] = full
        p.attrs["missing_value"] = np.float32(-9999)
        p.attrs["units"] = "mm/day"
    return path


def listing_html(entries: list[tuple[str, dt.datetime, int]]) -> str:
    """nginx's "fancy" index table, the style CHC serves (times in UTC, sizes
    rounded to 0.1 KiB/MiB, so a listing's size is never exact)."""
    rows = ['<tr><td class="link"><a href="../">Parent directory/</a></td><td class="size">-</td><td class="date">-</td></tr>']
    for n, when, size in entries:
        shown = f"{size / 2**20:.1f} MiB" if size >= 2**20 else f"{size / 2**10:.1f} KiB"
        rows.append(f'<tr><td class="link"><a href="{n}" title="{n}">{n}</a></td><td class="size">{shown}</td><td class="date">{when.strftime("%Y-%b-%d %H:%M")}</td></tr>')
    body = "\n".join(rows)
    return (
        f"<!DOCTYPE html>\n<html>\n<head><title>Index of {LISTING_PATH}</title></head>\n<body>\n<h1>Index of {LISTING_PATH}</h1>\n"
        f'<table id="list"><thead><tr><th>File Name</th><th>File Size</th><th>Date</th></tr></thead>\n<tbody>\n{body}\n</tbody></table>\n</body>\n</html>\n'
    )


def autoindex_html(entries: list[tuple[str, dt.datetime, int]]) -> str:
    """Plain nginx autoindex (autoindex_exact_size on, times in UTC): the other style parse_listing reads."""
    lines = ['<a href="../">../</a>']
    for n, when, size in entries:
        shown = n if len(n) <= 50 else n[:47] + "..&gt;"
        lines.append(f'<a href="{n}">{shown}</a>{" " * max(1, 51 - len(shown))}{when.strftime("%d-%b-%Y %H:%M")} {size:>19}')
    body = "\n".join(lines)
    return (
        f"<html>\n<head><title>Index of {LISTING_PATH}</title></head>\n<body>\n"
        f"<h1>Index of {LISTING_PATH}</h1><hr><pre>{body}\n</pre><hr></body>\n</html>\n"
    )


def write(outdir: Path = HERE) -> list[Path]:
    written = []
    sizes = {}
    for (y, m) in MONTHS:
        p = write_nc(outdir / name(y, m), first_day(y, m), month_values(y, m))
        sizes[(y, m)] = p.stat().st_size
        written.append(p)
    feb = name(2024, 2)
    rewritten = write_nc(outdir / "rewritten" / feb, first_day(2024, 2), month_values(2024, 2), chunks=(1, 95, 160), title="Synthetic CHIRPS-like fixture, copied again")
    changed = write_nc(outdir / "changed" / feb, first_day(2024, 2), month_values(2024, 2, "changed"))
    written += [rewritten, changed]
    readme = ("README.txt", dt.datetime(2024, 1, 2, 3, 4, tzinfo=dt.UTC), 1234)
    base = [(name(y, m), MTIME[(y, m)], sizes[(y, m)]) for (y, m) in MONTHS]
    for fname, feb_entry in [
        ("listing.html", base[1]),
        ("listing-rewritten.html", (feb, MTIME_REWRITTEN, rewritten.stat().st_size)),
        ("listing-changed.html", (feb, MTIME_CHANGED, changed.stat().st_size)),
    ]:
        p = outdir / fname
        p.write_text(listing_html([readme, base[0], feb_entry]))
        written.append(p)
    return written


if __name__ == "__main__":
    for p in write(Path(sys.argv[1]) if len(sys.argv) > 1 else HERE):
        print(p)
