"""Write the copy's Zarr v3 arrays (issue #604 D2), locally or in S3.

The copy is one Zarr v3 hierarchy per environment, named by `MIRROR_URL`:
`file:///abs/path` (dev, CI) or `s3://bucket[/prefix]` (production). Each
product is an array at `<product>/` with its manifest at
`<product>/manifest.json` (manifest.py).

Both layouts store float32 with NaN as the fill (sea or no data), codecs
[bytes little-endian, gzip 6] and the default "/" chunk key encoding. Chunks
that are all NaN are never written, and readers treat a missing chunk as NaN.

- Finals (`rnl`, `sat`, `era5l`): shape (years, 366, rows, cols), chunk
  (1, 366, 20, 20), dims (year, doy, lat, lon), year index = year -
  firstYear, doy index = days since 1 January (so index 365 stays NaN in a
  non-leap year).
- Daily (`prelim`, `imerg_late`, `gefs/<issue>`): shape (days, rows, cols),
  chunk (1, 110, 124) at 0.05 deg or (1, 55, 62) at 0.1 deg, dims (day, lat,
  lon), day index = days since `firstDay`.

rows x cols is the product's grid (grid.for_product): 550 x 620 at 0.05 deg
for CHIRPS, 275 x 310 at 0.1 deg for `era5l` and `imerg_late`. The arrays'
`grid` attribute carries the step, so a writer refuses an array of another grid.

S3 is reached through boto3 by staging: the objects a write can touch (the
hierarchy's root `zarr.json`, the array's `zarr.json` and the chunks of the
years or days written) are copied to a temporary directory, zarr writes there
through its LocalStore, and only the objects whose bytes changed go back up
(and any chunk zarr deleted, because it became all NaN, is deleted). That
keeps one code path for both backends and adds no fsspec/obstore dependency.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import numpy as np

import grid

FINALS_CHUNKS = grid.CHC.finals_chunks
DAILY_CHUNKS = grid.CHC.daily_chunks
GZIP_LEVEL = 6


def _attributes(extra: dict, g: grid.Grid = grid.CHC) -> dict:
    return {**extra, **g.attrs}


class Mirror:
    """One copy's storage: JSON documents plus a staging area for zarr writes."""

    def read_json(self, key: str) -> dict | None:
        raise NotImplementedError

    def write_json(self, key: str, doc: dict) -> None:
        raise NotImplementedError

    def stage(self, prefixes: list[str]) -> contextlib.AbstractContextManager[Path]:
        """A local directory holding the hierarchy's objects under `prefixes`
        (plus the root zarr.json); what changes there is kept on exit."""
        raise NotImplementedError

    @staticmethod
    def from_url(url: str, s3_client=None) -> "Mirror":
        u = urlparse(url)
        if u.scheme == "file":
            if u.netloc not in ("", "localhost") or not u.path.startswith("/"):
                raise ValueError(f"MIRROR_URL {url!r} must be file:///absolute/path")
            return LocalMirror(Path(u.path))
        if u.scheme == "s3":
            if not u.netloc:
                raise ValueError(f"MIRROR_URL {url!r} names no bucket")
            if s3_client is None:
                import boto3

                s3_client = boto3.client("s3")
            return S3Mirror(s3_client, u.netloc, u.path.strip("/"))
        raise ValueError(f"MIRROR_URL {url!r} must start with file:// or s3://")


class LocalMirror(Mirror):
    def __init__(self, root: Path):
        self.root = root

    def read_json(self, key):
        p = self.root / key
        return json.loads(p.read_text()) if p.exists() else None

    def write_json(self, key, doc):
        p = self.root / key
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(json.dumps(doc, indent=2) + "\n")
        os.replace(tmp, p)

    @contextlib.contextmanager
    def stage(self, prefixes):
        self.root.mkdir(parents=True, exist_ok=True)
        yield self.root


class S3Mirror(Mirror):
    def __init__(self, client, bucket: str, prefix: str):
        self.client = client
        self.bucket = bucket
        self.prefix = prefix

    def _key(self, key: str) -> str:
        return f"{self.prefix}/{key}" if self.prefix else key

    def read_json(self, key):
        try:
            body = self.client.get_object(Bucket=self.bucket, Key=self._key(key))["Body"].read()
        except self.client.exceptions.NoSuchKey:
            return None
        return json.loads(body)

    def write_json(self, key, doc):
        body = (json.dumps(doc, indent=2) + "\n").encode()
        self.client.put_object(Bucket=self.bucket, Key=self._key(key), Body=body, ContentType="application/json")

    def _list(self, prefix: str) -> list[str]:
        keys = []
        for page in self.client.get_paginator("list_objects_v2").paginate(Bucket=self.bucket, Prefix=self._key(prefix)):
            keys += [o["Key"] for o in page.get("Contents", [])]
        strip = len(self._key(""))
        return [k[strip:] for k in keys]

    @contextlib.contextmanager
    def stage(self, prefixes):
        with tempfile.TemporaryDirectory(prefix="mirror-stage-") as tmp:
            root = Path(tmp)
            pulled: dict[str, bytes] = {}
            for rel in ["zarr.json", *{k for p in prefixes for k in self._list(p)}]:
                try:
                    body = self.client.get_object(Bucket=self.bucket, Key=self._key(rel))["Body"].read()
                except self.client.exceptions.NoSuchKey:
                    continue
                pulled[rel] = body
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                (root / rel).write_bytes(body)
            yield root
            now = {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            for rel, body in sorted(now.items()):
                if pulled.get(rel) != body:
                    self.client.put_object(Bucket=self.bucket, Key=self._key(rel), Body=body)
            for rel in sorted(set(pulled) - set(now)):
                self.client.delete_object(Bucket=self.bucket, Key=self._key(rel))


def _open_or_create(root: Path, product: str, shape, chunks, dims, attrs: dict):
    import zarr
    from zarr.codecs import BytesCodec, GzipCodec

    store = zarr.storage.LocalStore(root)
    group = zarr.open_group(store=store, mode="a", zarr_format=3)
    if (root / product / "zarr.json").exists():
        arr = zarr.open_array(store=store, path=product, mode="r+", zarr_format=3)
        if arr.chunks != tuple(chunks) or arr.dtype != np.float32 or tuple(arr.metadata.dimension_names) != tuple(dims):
            raise ValueError(f"{product}/zarr.json does not hold the D2 layout this writer expects")
        for k, v in attrs.items():
            if arr.attrs.get(k) != v:
                raise ValueError(f"{product}/zarr.json attribute {k} is {arr.attrs.get(k)!r}, expected {v!r}")
        return arr
    return group.create_array(
        name=product,
        shape=shape,
        chunks=chunks,
        dtype="float32",
        fill_value=np.nan,
        serializer=BytesCodec(endian="little"),
        compressors=[GzipCodec(level=GZIP_LEVEL)],
        filters=None,
        dimension_names=dims,
        attributes=attrs,
    )


def _check_values(values: np.ndarray, rows=grid.ROWS, cols=grid.COLS) -> np.ndarray:
    if values.ndim != 3 or values.shape[1:] != (rows, cols):
        raise ValueError(f"values must be (days, {rows}, {cols}), got {values.shape}")
    return np.asarray(values, dtype=np.float32)


def finals_spans(first_day: dt.date, days: int) -> list[tuple[int, int, int, int]]:
    """Split consecutive days into per-year spans: [(year, doy_from, doy_to_excl, offset)]."""
    spans = []
    offset = 0
    day = first_day
    while offset < days:
        year_end = dt.date(day.year, 12, 31)
        n = min(days - offset, (year_end - day).days + 1)
        d0 = grid.doy_index(day)
        spans.append((day.year, d0, d0 + n, offset))
        offset += n
        day += dt.timedelta(days=n)
    return spans


def finals_year_prefixes(product: str, first_day: dt.date, days: int, first_year: int | None = None) -> list[str]:
    """The chunk key prefixes a finals write touches (one per year); `first_year` defaults to the product's."""
    if first_year is None:
        first_year = grid.for_product(product).first_year
    return [f"{product}/zarr.json", *(f"{product}/c/{grid.year_index(y, first_year)}/" for y, *_ in finals_spans(first_day, days))]


def read_finals(mirror_root: Path, product: str, first_day: dt.date, days: int) -> np.ndarray | None:
    """The finals values already stored for those days (NaN where unwritten);
    None when the array doesn't exist yet."""
    import zarr

    if not (mirror_root / product / "zarr.json").exists():
        return None
    arr = zarr.open_array(store=zarr.storage.LocalStore(mirror_root), path=product, mode="r", zarr_format=3)
    first_year = arr.attrs["firstYear"]
    g = grid.for_product(product)
    out = np.full((days, g.rows, g.cols), np.nan, dtype=np.float32)
    for year, d0, d1, off in finals_spans(first_day, days):
        yi = grid.year_index(year, first_year)
        if yi < arr.shape[0]:
            out[off : off + d1 - d0] = arr[yi, d0:d1]
    return out


def write_finals(mirror_root: Path, product: str, first_day: dt.date, values: np.ndarray, first_year: int | None = None, attrs: dict | None = None):
    """Write consecutive days of the region (on the product's grid) into the
    finals array at `<mirror_root>/<product>/`, creating it (D2 metadata) when
    absent and growing its year axis as needed. Days outside the write keep
    their values. `first_year` defaults to the product's (1981, era5l's 1950).
    `attrs` are the product's own attributes beside the layout's (era5l's
    `attribution`); an existing array must already carry them."""
    g = grid.for_product(product)
    if first_year is None:
        first_year = g.first_year
    values = _check_values(values, g.rows, g.cols)
    spans = finals_spans(first_day, values.shape[0])
    last_year = spans[-1][0]
    years = grid.year_index(last_year, first_year) + 1
    arr = _open_or_create(
        mirror_root,
        product,
        shape=(years, grid.DOYS, g.rows, g.cols),
        chunks=g.finals_chunks,
        dims=("year", "doy", "lat", "lon"),
        attrs=_attributes({**(attrs or {}), "firstYear": first_year}, g),
    )
    if arr.shape[0] < years:
        arr.resize((years, grid.DOYS, g.rows, g.cols))
    for year, d0, d1, off in spans:
        arr[grid.year_index(year, first_year), d0:d1] = values[off : off + d1 - d0]
    return arr


def read_daily_day(mirror_root: Path, product: str, day: dt.date) -> np.ndarray | None:
    """One day of a daily array, (rows, cols) with NaN where unwritten; None
    when the array doesn't exist yet or ends before `day`."""
    import zarr

    if not (mirror_root / product / "zarr.json").exists():
        return None
    arr = zarr.open_array(store=zarr.storage.LocalStore(mirror_root), path=product, mode="r", zarr_format=3)
    i = (day - dt.date.fromisoformat(arr.attrs["firstDay"])).days
    if i < 0:
        raise ValueError(f"{day} is before {product}'s firstDay {arr.attrs['firstDay']}")
    return np.array(arr[i]) if i < arr.shape[0] else None


def write_daily(mirror_root: Path, product: str, first_day: dt.date, values: np.ndarray, array_first_day: dt.date | None = None):
    """Write consecutive days into the daily array at `<mirror_root>/<product>/`
    (day index = days since its `firstDay` attribute, which is `array_first_day`,
    or `first_day`, when the array is created), on the product's grid."""
    g = grid.for_product(product)
    values = _check_values(values, g.rows, g.cols)
    if (mirror_root / product / "zarr.json").exists():
        arr = _open_or_create(mirror_root, product, None, g.daily_chunks, ("day", "lat", "lon"), {"grid": g.attrs["grid"]})
    else:
        start = array_first_day or first_day
        arr = _open_or_create(
            mirror_root,
            product,
            shape=(max(0, (first_day - start).days) + values.shape[0], g.rows, g.cols),
            chunks=g.daily_chunks,
            dims=("day", "lat", "lon"),
            attrs=_attributes({"firstDay": start.isoformat()}, g),
        )
    origin = dt.date.fromisoformat(arr.attrs["firstDay"])
    i0 = (first_day - origin).days
    if i0 < 0:
        raise ValueError(f"{first_day} is before {product}'s firstDay {origin}")
    end = i0 + values.shape[0]
    if arr.shape[0] < end:
        arr.resize((end, g.rows, g.cols))
    arr[i0:end] = values
    return arr
