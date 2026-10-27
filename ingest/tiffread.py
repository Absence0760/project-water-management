"""A minimal GeoTIFF strip reader for verify_copy.py: one pixel of a CHC daily
grid through range requests (the header, the image directory, one strip),
never the whole file. Standard library only.

It is the Python twin of the backend's reader (backend/src/feeds/sources/tiff.ts),
which is what the cache read before the copy existed, and accepts the same
files: classic TIFF in either byte order, one float32 band (SampleFormat 3),
no predictor, strips (CHC: one row per strip, the IFD at the end of the file,
LZW), georeferenced on WGS 84 in degrees (tiepoint (-180, 60), 0.05 deg).
Compression 1 (none), 5 (LZW) and 8 (deflate) are read. Anything else (BigTIFF,
tiles, a predictor, several bands, a reversed fill order, another coordinate
system) raises TiffFormatError rather than being guessed at.

`read` is a callable (first, last) -> bytes | None, inclusive like HTTP Range;
None means the file doesn't exist (404). A server may clip a range at the end
of the file, so a short answer for the IFD block is fine.
"""

from __future__ import annotations

import math
import re
import struct
import zlib
from dataclasses import dataclass
from typing import Callable

RangeRead = Callable[[int, int], "bytes | None"]


class TiffFormatError(ValueError):
    """The file is not a TIFF this reader accepts."""


TAG_WIDTH = 256
TAG_HEIGHT = 257
TAG_BITS = 258
TAG_COMPRESSION = 259
TAG_FILL_ORDER = 266
TAG_STRIP_OFFSETS = 273
TAG_SAMPLES = 277
TAG_ROWS_PER_STRIP = 278
TAG_STRIP_COUNTS = 279
TAG_PLANAR = 284
TAG_PREDICTOR = 317
TAG_TILE_WIDTH = 322
TAG_SAMPLE_FORMAT = 339
TAG_PIXEL_SCALE = 33550
TAG_TIEPOINT = 33922
TAG_GEOKEYS = 34735
TAG_GDAL_NODATA = 42113

TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}
_TYPE_FMT = {1: "B", 3: "H", 4: "I", 11: "f", 12: "d"}

IFD_READ = 64 * 1024
MAX_DIM = 100_000
MAX_STRIP_BYTES = 8 * 1024 * 1024
MAX_DECODED_STRIP_BYTES = 2 * 1024 * 1024
# A value at or below this, or NaN, is "no data" (CHC writes -9999 over the sea), as in tiff.ts.
NODATA_FLOOR = -9000.0


@dataclass
class Grid:
    width: int
    height: int
    rows_per_strip: int
    compression: int
    little_endian: bool
    origin_lon: float  # the top-left corner of pixel (0, 0)
    origin_lat: float
    scale_lon: float
    scale_lat: float
    nodata: float | None
    strip_offsets: tuple[int, ...]
    strip_counts: tuple[int, ...]

    def pixel(self, lat: float, lon: float) -> tuple[int, int]:
        """(row, col) of the pixel holding a point; row 0 is the north edge."""
        eps = 1e-6
        col = math.floor((lon - self.origin_lon) / self.scale_lon + eps)
        row = math.floor((self.origin_lat - lat) / self.scale_lat + eps)
        if not (0 <= row < self.height and 0 <= col < self.width):
            raise TiffFormatError(f"the point {lat}, {lon} is outside the grid")
        return row, col


def _need(got: bytes | None, n: int, what: str) -> bytes:
    if got is None or len(got) < n:
        raise TiffFormatError(f"the file ends before {what}")
    return got


#: A decimal number as GDAL writes GDAL_NODATA ("-9999", "-3.4e+38"); "nan" and "inf" are no number here.
_NODATA_NUMBER = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?")


def _gdal_nodata(text: str) -> float | None:
    """The file's GDAL_NODATA as the float32 the writer stored, or None when it
    names no finite number. That is the backend's reader's rule (tiff.ts takes
    Number(text) only when it is finite), and the twins accept the same files;
    NaN and values at or below NODATA_FLOOR are no data either way."""
    if not _NODATA_NUMBER.fullmatch(text):
        return None
    v = float(text)
    if not math.isfinite(v):  # a decimal past float range ("1e999")
        return None
    return struct.unpack("f", struct.pack("f", v))[0]


def open_grid(read: RangeRead) -> Grid | None:
    """The header and first IFD; None when the file doesn't exist."""
    head = read(0, 15)
    if head is None:
        return None
    head = _need(head, 8, "its header")
    if head[:2] == b"II":
        bo = "<"
    elif head[:2] == b"MM":
        bo = ">"
    else:
        raise TiffFormatError("the file is not a TIFF")
    magic, ifd = struct.unpack(bo + "HI", head[2:8])
    if magic == 43:
        raise TiffFormatError("BigTIFF is not supported")
    if magic != 42:
        raise TiffFormatError("the file is not a TIFF")
    if ifd < 8:
        raise TiffFormatError("the file has no image directory")

    block = _need(read(ifd, ifd + IFD_READ - 1), 2, "its image directory")
    (n,) = struct.unpack(bo + "H", block[:2])
    if n == 0 or 2 + n * 12 > len(block):
        raise TiffFormatError("the image directory is truncated")

    entries: dict[int, tuple[int, int, int]] = {}  # tag -> (type, count, absolute offset)
    for i in range(n):
        p = 2 + i * 12
        tag, typ, count = struct.unpack(bo + "HHI", block[p : p + 8])
        size = TYPE_SIZE.get(typ)
        if size is None:
            continue
        offset = ifd + p + 8 if size * count <= 4 else struct.unpack(bo + "I", block[p + 8 : p + 12])[0]
        entries[tag] = (typ, count, offset)

    def raw(tag: int, first: int = 0, count: int | None = None) -> tuple[int, bytes]:
        typ, total, offset = entries[tag]
        count = total if count is None else count
        size = TYPE_SIZE[typ]
        start = offset + first * size
        length = count * size
        if ifd <= start and start + length <= ifd + len(block):
            return typ, block[start - ifd : start - ifd + length]
        return typ, _need(read(start, start + length - 1), length, "a value of its image directory")[:length]

    def values(tag: int, count: int | None = None) -> list:
        typ, data = raw(tag, 0, count)
        fmt = _TYPE_FMT.get(typ)
        if fmt is None:
            raise TiffFormatError(f"tag {tag} uses TIFF type {typ} where a number was expected")
        return list(struct.unpack(bo + fmt * (len(data) // TYPE_SIZE[typ]), data))

    def scalar(tag: int, fallback: int | None = None):
        if tag not in entries:
            if fallback is None:
                raise TiffFormatError(f"the file lacks TIFF tag {tag}")
            return fallback
        return values(tag, 1)[0]

    if TAG_TILE_WIDTH in entries:
        raise TiffFormatError("tiled grids are not supported")
    width, height = scalar(TAG_WIDTH), scalar(TAG_HEIGHT)
    if not (1 <= width <= MAX_DIM and 1 <= height <= MAX_DIM):
        raise TiffFormatError("the grid has implausible dimensions")
    if scalar(TAG_BITS) != 32 or scalar(TAG_SAMPLE_FORMAT, 1) != 3:
        raise TiffFormatError("the grid is not 32-bit floating point")
    if scalar(TAG_SAMPLES, 1) != 1:
        raise TiffFormatError("the grid has more than one band")
    if scalar(TAG_PLANAR, 1) != 1:
        raise TiffFormatError("the grid's planar configuration is not supported")
    if scalar(TAG_PREDICTOR, 1) != 1:
        raise TiffFormatError("the grid uses a TIFF predictor, which is not supported")
    if scalar(TAG_FILL_ORDER, 1) != 1:
        raise TiffFormatError("the grid uses a reversed bit fill order, which is not supported")
    compression = scalar(TAG_COMPRESSION, 1)
    if compression not in (1, 5, 8):
        raise TiffFormatError(f"the grid uses TIFF compression {compression}, which is not supported")
    rows_per_strip = min(scalar(TAG_ROWS_PER_STRIP, height), height)
    if rows_per_strip < 1:
        raise TiffFormatError("the grid has no rows per strip")

    for tag, cnt in ((TAG_PIXEL_SCALE, 2), (TAG_TIEPOINT, 6)):
        if tag not in entries or entries[tag][0] != 12 or entries[tag][1] < cnt:
            raise TiffFormatError("the grid has no usable georeferencing")
    # IDL writes 0.05 from a float32 (0.05000000074505806): snap to the 7 digits a float32 carries, as tiff.ts does.
    scale_lon, scale_lat = (float(f"{v:.7g}") for v in values(TAG_PIXEL_SCALE, 2))
    ti, tj, _, tx, ty, _ = values(TAG_TIEPOINT, 6)
    if not (scale_lon > 0 and scale_lat > 0) or not all(map(math.isfinite, (ti, tj, tx, ty))):
        raise TiffFormatError("the grid has no usable georeferencing")

    if TAG_GEOKEYS not in entries or entries[TAG_GEOKEYS][0] != 3 or not 4 <= entries[TAG_GEOKEYS][1] <= 4096:
        raise TiffFormatError("the grid does not say its coordinate system")
    gk = values(TAG_GEOKEYS)
    keys = gk[3]
    if 4 + keys * 4 > len(gk):
        raise TiffFormatError("the grid's GeoKey directory is truncated")
    geo = {gk[4 + k * 4]: gk[4 + k * 4 + 3] for k in range(keys) if gk[4 + k * 4 + 1] == 0}
    if geo.get(1024) != 2:
        raise TiffFormatError("the grid is not in geographic coordinates")
    if geo.get(2048) != 4326:
        raise TiffFormatError("the grid's coordinate system is not WGS 84 (EPSG:4326)")
    if geo.get(2054, 9102) != 9102:
        raise TiffFormatError("the grid's angles are not in degrees")
    raster_type = geo.get(1025, 1)
    if raster_type not in (1, 2):
        raise TiffFormatError(f"the grid has an unknown raster type {raster_type}")
    half = 0.5 if raster_type == 2 else 0.0

    strips = math.ceil(height / rows_per_strip)
    if TAG_STRIP_OFFSETS not in entries or TAG_STRIP_COUNTS not in entries:
        raise TiffFormatError("the strip table is missing")
    offsets = values(TAG_STRIP_OFFSETS)
    counts = values(TAG_STRIP_COUNTS)
    if len(offsets) < strips or len(counts) < strips:
        raise TiffFormatError("the strip table is short")

    nodata = None
    if TAG_GDAL_NODATA in entries and entries[TAG_GDAL_NODATA][0] == 2 and entries[TAG_GDAL_NODATA][1] <= 256:
        nodata = _gdal_nodata(raw(TAG_GDAL_NODATA)[1].rstrip(b"\0").decode("ascii", "replace").strip())

    return Grid(
        width=width,
        height=height,
        rows_per_strip=rows_per_strip,
        compression=compression,
        little_endian=bo == "<",
        origin_lon=tx - (ti + half) * scale_lon,
        origin_lat=ty + (tj + half) * scale_lat,
        scale_lon=scale_lon,
        scale_lat=scale_lat,
        nodata=nodata,
        strip_offsets=tuple(offsets[:strips]),
        strip_counts=tuple(counts[:strips]),
    )


def read_pixel_bits(read: RangeRead, g: Grid, lat: float, lon: float) -> int | None:
    """The float32 bit pattern at a point, or None where the grid says no data.
    One range request: the strip holding the pixel."""
    row, col = g.pixel(lat, lon)
    s = row // g.rows_per_strip
    offset, nbytes = g.strip_offsets[s], g.strip_counts[s]
    if not 0 < nbytes <= MAX_STRIP_BYTES:
        raise TiffFormatError("a strip of the grid has an implausible size")
    stored = _need(read(offset, offset + nbytes - 1), nbytes, "a strip")[:nbytes]
    rows = min(g.rows_per_strip, g.height - s * g.rows_per_strip)
    expected = rows * g.width * 4
    if expected > MAX_DECODED_STRIP_BYTES:
        raise TiffFormatError("a strip of the grid would decode to an implausible size")
    if g.compression == 5:
        data = lzw_decode(stored, expected)
    elif g.compression == 8:
        try:
            data = zlib.decompressobj().decompress(stored, expected)
        except zlib.error as e:
            raise TiffFormatError(f"a strip of the grid is not valid deflate: {e}") from None
    else:
        data = stored
    if len(data) < expected:
        raise TiffFormatError("a strip of the grid is truncated")
    at = ((row - s * g.rows_per_strip) * g.width + col) * 4
    bo = "<" if g.little_endian else ">"
    (bits,) = struct.unpack(bo + "I", data[at : at + 4])
    (value,) = struct.unpack(bo + "f", data[at : at + 4])
    if math.isnan(value) or value <= NODATA_FLOOR or (g.nodata is not None and value == g.nodata):
        return None
    return bits


def lzw_decode(data: bytes, expected: int) -> bytes:
    """TIFF LZW (TIFF 6.0 section 13): MSB-first codes of 9-12 bits, Clear 256,
    End 257, "early change". Decodes at most `expected` bytes."""
    out = bytearray()
    table: list[bytes] = [bytes([i]) for i in range(256)] + [b"", b""]
    width = 9
    bit = 0
    total = len(data) * 8
    prev: bytes | None = None
    while len(out) < expected:
        if bit + width > total:
            break
        code = 0
        for _ in range(width):
            code = (code << 1) | ((data[bit >> 3] >> (7 - (bit & 7))) & 1)
            bit += 1
        if code == 257:
            break
        if code == 256:
            del table[258:]
            width = 9
            prev = None
            continue
        if code < len(table):
            entry = table[code]
        elif code == len(table) and prev is not None:
            entry = prev + prev[:1]
        else:
            raise TiffFormatError("a strip of the grid is not valid LZW")
        out += entry
        if prev is not None:
            if len(table) >= 4096:
                raise TiffFormatError("a strip of the grid is not valid LZW")
            table.append(prev + entry[:1])
            if len(table) >= (1 << width) - 1 and width < 12:
                width += 1
        prev = entry
    return bytes(out[:expected])
