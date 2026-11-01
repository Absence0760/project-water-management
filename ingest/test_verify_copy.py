"""verify_copy.py and tiffread.py, all offline: no CHC, no dynamical.org.

    ingest/.venv/bin/python -m unittest discover -s ingest
"""

import datetime as dt
import email.message
import io
import json
import struct
import sys
import tempfile
import time
import unittest
import unittest.mock
import urllib.error
import zlib
from collections import Counter
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import grid  # noqa: E402
import lease  # noqa: E402
import manifest  # noqa: E402
import polite  # noqa: E402
import tiffread  # noqa: E402
import verify_copy as vc  # noqa: E402
import zarrstore  # noqa: E402

# --- a synthetic GeoTIFF ------------------------------------------------------


def lzw_encode(data: bytes) -> bytes:
    """TIFF LZW with early change, the way backend/src/feeds/sources/tiff-write.ts writes it."""
    out = bytearray()
    acc = bits = 0
    width = 9

    def write(code):
        nonlocal acc, bits
        acc = (acc << width) | code
        bits += width
        while bits >= 8:
            out.append((acc >> (bits - 8)) & 0xFF)
            bits -= 8
        acc &= (1 << bits) - 1

    table: dict[bytes, int] = {}
    nxt = 258
    write(256)
    w = b""
    w_code = -1
    for byte in data:
        wc = w + bytes([byte])
        known = byte if len(wc) == 1 else table.get(wc)
        if known is not None:
            w, w_code = wc, known
            continue
        write(w_code)
        table[wc] = nxt
        nxt += 1
        if nxt > (1 << width) - 1 and width < 12:
            width += 1
        if nxt >= 4094:
            write(256)
            table, nxt, width = {}, 258, 9
        w, w_code = bytes([byte]), byte
    if w_code != -1:
        write(w_code)
    if nxt + 1 > (1 << width) - 1 and width < 12:
        width += 1
    write(257)
    if bits:
        out.append((acc << (8 - bits)) & 0xFF)
    return bytes(out)


def make_tiff(values, origin_lon, origin_lat, scale=0.05, compression=5, rows_per_strip=1, big_endian=False, geokeys=None, extra=None, nodata=b"-9999\0"):
    """A GeoTIFF of `values` (rows north-up), strips first and the IFD at the
    end, like CHC's files. `extra` adds (tag, type, values) entries."""
    bo = ">" if big_endian else "<"
    v = np.asarray(values, dtype=np.float32)
    h, w = v.shape
    raw = v.astype(bo + "f4").tobytes()
    body = bytearray(b"MM\x00\x2a" if big_endian else b"II\x2a\x00") + b"\0\0\0\0"
    offsets, counts = [], []
    for r0 in range(0, h, rows_per_strip):
        strip = raw[r0 * w * 4 : min(h, r0 + rows_per_strip) * w * 4]
        enc = lzw_encode(strip) if compression == 5 else zlib.compress(strip) if compression == 8 else strip
        offsets.append(len(body))
        counts.append(len(enc))
        body += enc
    if len(body) % 2:
        body += b"\0"
    keys = geokeys if geokeys is not None else [1, 1, 0, 4, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326, 2054, 0, 1, 9102]
    entries = [
        (256, 4, [w]),
        (257, 4, [h]),
        (258, 3, [32]),
        (259, 3, [compression]),
        (273, 4, offsets),
        (277, 3, [1]),
        (278, 4, [rows_per_strip]),
        (279, 4, counts),
        (339, 3, [3]),
        (33550, 12, [scale, scale, 0.0]),
        (33922, 12, [0.0, 0.0, 0.0, origin_lon, origin_lat, 0.0]),
        (34735, 3, keys),
        (42113, 2, nodata),
    ] + list(extra or [])
    entries.sort(key=lambda e: e[0])
    fmt = {2: "s", 3: "H", 4: "I", 12: "d"}
    size = {2: 1, 3: 2, 4: 4, 12: 8}
    ifd = len(body)
    struct.pack_into(bo + "I", body, 4, ifd)
    head = bytearray(struct.pack(bo + "H", len(entries)))
    data_at = ifd + 2 + 12 * len(entries) + 4
    tail = bytearray()
    for tag, typ, vals in entries:
        count = len(vals)
        packed = vals if typ == 2 else struct.pack(bo + fmt[typ] * count, *vals)
        if size[typ] * count <= 4:
            head += struct.pack(bo + "HHI", tag, typ, count) + packed.ljust(4, b"\0")
        else:
            head += struct.pack(bo + "HHII", tag, typ, count, data_at + len(tail))
            tail += packed
            if len(tail) % 2:
                tail += b"\0"
    return bytes(body + head + b"\0\0\0\0" + tail)


class Reader:
    """A RangeRead over bytes that counts its requests."""

    def __init__(self, data):
        self.data = data
        self.requests = 0

    def __call__(self, first, last):
        self.requests += 1
        return self.data[first : last + 1]


def f32bits(x):
    return struct.unpack("<I", struct.pack("<f", x))[0]


class TiffReader(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(1)
        self.values = rng.gamma(0.4, 6.0, size=(30, 40)).astype(np.float32)
        self.values[0, 0] = -9999.0
        self.values[5, 7] = 0.0
        self.values[29, 39] = 12.345678

    def lat_lon(self, row, col, origin_lat=-30.0, origin_lon=20.0, scale=0.05):
        return origin_lat - (row + 0.5) * scale, origin_lon + (col + 0.5) * scale

    def check_every_pixel(self, **kw):
        data = make_tiff(self.values, 20.0, -30.0, **kw)
        r = Reader(data)
        g = tiffread.open_grid(r)
        self.assertEqual(r.requests, 2)  # the header, then the IFD with its arrays
        for row in range(30):
            for col in range(40):
                got = tiffread.read_pixel_bits(r, g, *self.lat_lon(row, col))
                want = None if self.values[row, col] == -9999 else f32bits(self.values[row, col])
                self.assertEqual(got, want, (row, col))
        self.assertEqual(r.requests, 2 + 30 * 40)  # one strip per pixel

    def test_lzw_one_row_per_strip_as_chc_writes_it(self):
        self.check_every_pixel(compression=5)

    def test_deflate_none_several_rows_per_strip_and_big_endian(self):
        self.check_every_pixel(compression=8)
        self.check_every_pixel(compression=1, rows_per_strip=7)
        self.check_every_pixel(compression=5, rows_per_strip=4, big_endian=True)

    def test_lzw_round_trips_past_the_table_reset(self):
        data = np.random.default_rng(2).integers(0, 256, size=50_000, dtype=np.uint8).tobytes()
        self.assertEqual(tiffread.lzw_decode(lzw_encode(data), len(data)), data)
        rep = b"abcabcabcd" * 5000
        self.assertEqual(tiffread.lzw_decode(lzw_encode(rep), len(rep)), rep)

    def test_a_missing_file_is_none(self):
        self.assertIsNone(tiffread.open_grid(lambda a, b: None))

    def test_refuses_what_it_does_not_read(self):
        cases = {
            "tiled": dict(extra=[(322, 3, [16])]),
            "predictor": dict(extra=[(317, 3, [2])]),
            "compression": dict(compression=7),
            "WGS 84": dict(geokeys=[1, 1, 0, 2, 1024, 0, 1, 2, 2048, 0, 1, 4269]),
            "geographic": dict(geokeys=[1, 1, 0, 2, 1024, 0, 1, 1, 2048, 0, 1, 4326]),
        }
        for what, kw in cases.items():
            with self.subTest(what):
                data = make_tiff(self.values, 20.0, -30.0, **{"compression": 1, **kw})
                with self.assertRaises(tiffread.TiffFormatError):
                    tiffread.open_grid(Reader(data))
        with self.assertRaises(tiffread.TiffFormatError):
            tiffread.open_grid(Reader(b"GIF89a" + b"\0" * 20))

    def test_gdal_nodata_is_read_only_when_it_names_a_finite_number(self):
        """tiff.ts's rule (Number(text), kept only when finite), so the twins accept the same files."""
        cases = {b"-9999\0": -9999.0, b"1e3\0": 1000.0, b" -3.5 \0": -3.5, b"none\0": None, b"nan\0": None, b"inf\0": None, b"1e999\0": None, b"\0": None}
        for text, want in cases.items():
            with self.subTest(text):
                self.assertEqual(tiffread.open_grid(Reader(make_tiff(self.values, 20.0, -30.0, nodata=text))).nodata, want)

    def test_a_point_outside_the_grid_is_refused(self):
        g = tiffread.open_grid(Reader(make_tiff(self.values, 20.0, -30.0)))
        with self.assertRaises(tiffread.TiffFormatError):
            g.pixel(-10.0, 20.1)


# --- a copy and a fake CHC ------------------------------------------------------

DAYS = [dt.date(2024, 2, 27), dt.date(2024, 2, 28), dt.date(2024, 2, 29)]


def region_values(seed):
    rng = np.random.default_rng(seed)
    v = rng.gamma(0.5, 8.0, size=(len(DAYS), grid.ROWS, grid.COLS)).astype(np.float32)
    v[:, :200, :300] = np.nan  # sea
    return v


def write_copy(root: Path):
    """rnl and sat holding February 2024, of which only Feb 27-29 has values."""
    for i, p in enumerate(vc.FINALS):
        zarrstore.write_finals(root, p, DAYS[0], region_values(10 + i))
        m = manifest.new(p)
        m["years"] = {"first": 2024, "last": 2024}
        m["finalThrough"] = "2024-02-29"
        m["files"].append(
            {
                "url": f"https://data.chc.ucsb.edu/products/CHIRPS/v3.0/daily/final/{p}/netcdf/byMonth/chirps-v3.0.2024.02.days_p05.nc",
                "etag": None,
                "lastModified": None,
                "size": 1,
                "valuesSha256": "0" * 64,
                "revision": 1,
                "fetchedAt": "2026-10-27T00:00:00Z",
            }
        )
        (root / p / "manifest.json").write_text(json.dumps(m))


def copy_values(product, day):
    """What the copy holds for a day: the written values, or all NaN."""
    if day in DAYS:
        return region_values(10 + vc.FINALS.index(product))[DAYS.index(day)]
    return np.full((grid.ROWS, grid.COLS), np.nan, dtype=np.float32)


def region_tiff(values_south_up):
    """A GeoTIFF over exactly D1's region (north-up, -9999 for NaN)."""
    north_up = np.where(np.isnan(values_south_up), np.float32(-9999), values_south_up)[::-1]
    return make_tiff(north_up, grid.REGION["w"], grid.REGION["n"], compression=1)


def headers(**kv):
    h = email.message.Message()
    for k, v in kv.items():
        h[k] = v
    return h


class FakeResponse(io.BytesIO):
    def __init__(self, body, status):
        super().__init__(body)
        self.status = status
        self.headers = headers()


class FakeChc:
    """An opener serving CHC's daily TIFFs of February 2024 by URL, with Range
    (206): the copy's values unless `files` overrides a URL (None: 404).
    `refuse` answers 403."""

    def __init__(self, files=None, refuse=False):
        self.files = dict(files or {})
        self.refuse = refuse
        self.requests = []
        for p in vc.FINALS:
            for d in range(1, 30):
                day = dt.date(2024, 2, d)
                self.files.setdefault(vc.chc_url(p, day), (p, day))

    def tiff(self, url):
        f = self.files.get(url)
        if isinstance(f, tuple):
            f = self.files[url] = region_tiff(copy_values(*f))
        return f

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        if self.refuse:
            raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", headers(), io.BytesIO(b""))
        data = self.tiff(req.full_url)
        if data is None:
            raise urllib.error.HTTPError(req.full_url, 404, "Not Found", headers(), io.BytesIO(b""))
        first, last = map(int, req.get_header("Range").removeprefix("bytes=").split("-"))
        return FakeResponse(data[first : last + 1], 206)


class FakeTime:
    def __init__(self):
        self.now = 1000.0
        self.slept = []

    def clock(self):
        return self.now

    def sleep(self, s):
        self.slept.append(s)
        self.now += s


def client_for(chc, t=None):
    t = t or FakeTime()
    return polite.PoliteClient(min_interval=1.0, clock=t.clock, sleep=t.sleep, opener=chc)


class CopyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        write_copy(self.root)
        self.url = f"file://{self.root}"

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, *args, client=None, dynamical=None, slot_sleep=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = vc.main(["--mirror", self.url, "--today", "2024-04-01", "--first-month", "2024-02", *args], client=client, dynamical=dynamical, slot_sleep=slot_sleep)
        self.stderr = err.getvalue()
        return code, out.getvalue()


class ReadsTheCopy(CopyTest):
    def test_values_and_region_match_what_was_written(self):
        arr = vc.FinalsArray(vc.CopyStore(self.url), "rnl")
        v = region_values(10)
        self.assertEqual(vc.bits_of(arr.value(DAYS[2], 400, 500)), f32bits(v[2, 400, 500]))
        self.assertIsNone(vc.bits_of(arr.value(DAYS[0], 0, 0)))
        np.testing.assert_array_equal(arr.region(DAYS[0], 3), v)
        self.assertTrue(np.isnan(arr.region(dt.date(2024, 3, 1), 2)).all())  # never written


class Sampling(unittest.TestCase):
    SPANS = {"rnl": (dt.date(1981, 1, 1), dt.date(2026, 8, 31)), "sat": (dt.date(2000, 6, 1), dt.date(2026, 8, 31))}

    def test_seeded(self):
        a = vc.plan_samples(200, 7, self.SPANS)
        self.assertEqual(a, vc.plan_samples(200, 7, self.SPANS))
        self.assertNotEqual(a, vc.plan_samples(200, 8, self.SPANS))

    def test_stratified_across_products_and_years(self):
        s = vc.plan_samples(200, 604, self.SPANS)
        self.assertEqual(Counter(x.product for x in s), {"rnl": 100, "sat": 100})
        for p, (first, last) in self.SPANS.items():
            years = Counter(x.day.year for x in s if x.product == p)
            self.assertEqual(set(years), set(range(first.year, last.year + 1)), p)  # every year drawn
            self.assertLessEqual(max(years.values()) - min(years.values()), 1, p)  # evenly
            self.assertTrue(all(first <= x.day <= last for x in s if x.product == p))
        self.assertTrue(all(0 <= x.row < grid.ROWS and 0 <= x.col < grid.COLS for x in s))

    def test_fewer_samples_than_years_spread_over_the_span(self):
        s = vc.plan_samples(10, 1, self.SPANS)
        decades = {x.day.year // 10 for x in s if x.product == "rnl"}
        self.assertEqual(decades, {198, 199, 200, 201, 202})

    def test_cell_centres(self):
        x = vc.Sample("rnl", DAYS[0], 0, 619)
        self.assertEqual((x.lat, x.lon), (-35.475, 40.975))


SPANS = {p: (dt.date(2024, 2, 1), dt.date(2024, 2, 29)) for p in vc.FINALS}


class AgainstChc(CopyTest):
    def test_bit_equal_passes_at_one_request_a_second(self):
        t = FakeTime()
        chc = FakeChc()
        stamps = []
        opener = lambda req, timeout=None: (stamps.append(t.now), chc(req, timeout))[1]  # noqa: E731
        code, out = self.run_main("--checks", "coverage,chc", "--samples", "12", client=client_for(opener, t))
        self.assertEqual(code, 0, out)
        self.assertIn("**12 bit-equal**", out)
        self.assertEqual(len(stamps), 36)  # header, IFD, one strip per cell-day
        self.assertTrue(all(b - a >= 1.0 for a, b in zip(stamps, stamps[1:])))
        self.assertTrue(all(r.get_header("User-agent").startswith("water-management-ingest/1") for r in chc.requests))

    def test_a_mismatch_fails_with_both_values(self):
        s = vc.plan_samples(12, 604, SPANS)[3]  # the run's own sample (main's default seed)
        v = copy_values(s.product, s.day).copy()
        want = v[s.row, s.col]
        v[s.row, s.col] = 1.0 if np.isnan(want) else np.nextafter(want, np.float32(1e9))  # one ulp off
        code, out = self.run_main("--checks", "chc", "--samples", "12", client=client_for(FakeChc({vc.chc_url(s.product, s.day): region_tiff(v)})))
        self.assertEqual(code, 1)
        self.assertIn("1 different", out)
        self.assertIn(f"| {s.product} | {s.day} | {s.lat} | {s.lon} | {vc.float_of(vc.bits_of(want))} | {vc.float_of(f32bits(v[s.row, s.col]))} |", out)

    def test_a_missing_daily_file_fails(self):
        s = vc.plan_samples(12, 604, SPANS)[0]
        code, out = self.run_main("--checks", "chc", "--samples", "12", client=client_for(FakeChc({vc.chc_url(s.product, s.day): None})))
        self.assertEqual(code, 1)
        self.assertIn("HTTP 404", out)

    def test_a_403_stops_the_run_at_once(self):
        chc = FakeChc(refuse=True)
        code, out = self.run_main("--checks", "chc", "--samples", "12", client=client_for(chc))
        self.assertEqual(code, 1)
        self.assertEqual(len(chc.requests), 1)  # never retried, no other cell-day tried
        self.assertIn("**Stopped:**", out)
        self.assertIn("HTTP 403", out)


def wait_for(cond, seconds=5.0):
    """Wait on the renewal thread's visible effect (a real signal), failing after `seconds`."""
    end = time.monotonic() + seconds
    while not cond():
        if time.monotonic() > end:
            raise AssertionError("timed out waiting for the renewal thread")
        time.sleep(0.005)


class ChcSlot(CopyTest):
    """The CHC check takes CHC's one request slot (lease.py), shared with every other caller of CHC."""

    def slot(self):
        p = self.root / lease.host_slot_key("chc")
        return json.loads(p.read_text()) if p.exists() else None

    def reservation(self):
        return (self.root / lease.host_reservation_key("chc")).exists()

    def hold_elsewhere(self, holder="fetch:chirps-final"):
        p = self.root / lease.host_slot_key("chc")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"owner": "someone-else", "expires": time.time() + 3600, "holder": holder}))

    def test_taken_before_the_first_request_and_released_after(self):
        chc = FakeChc()
        seen = []
        opener = lambda req, timeout=None: (seen.append(self.slot()), chc(req, timeout))[1]  # noqa: E731
        code, out = self.run_main("--checks", "chc", "--samples", "4", client=client_for(opener))
        self.assertEqual(code, 0, out)
        self.assertEqual(len(seen), 12)
        self.assertTrue(all(s is not None and s["holder"].startswith("verify:") and "@" in s["holder"] for s in seen), seen[:1])
        self.assertEqual(len({s["owner"] for s in seen}), 1)  # one hold for the whole check
        self.assertIsNone(self.slot())  # released
        self.assertFalse(self.reservation())

    def test_a_busy_slot_sends_no_request_and_fails_naming_the_holder(self):
        self.hold_elsewhere()
        chc = FakeChc()
        code, out = self.run_main("--checks", "chc", "--samples", "4", "--slot-wait", "0", client=client_for(chc))
        self.assertEqual(code, 1)
        self.assertEqual(chc.requests, [])
        self.assertIn("**Stopped:**", out)
        self.assertIn("fetch:chirps-final", out)
        self.assertIn("no CHC request was sent", out)
        self.assertEqual(self.slot()["owner"], "someone-else")  # left alone
        self.assertFalse(self.reservation())  # our reservation of the next turn is withdrawn on giving up

    def test_waits_for_a_busy_slot_then_takes_it(self):
        self.hold_elsewhere()
        chc = FakeChc()
        slept = []

        def sleep(s):
            slept.append(s)
            self.assertTrue(self.reservation())  # waiting, it reserved the next turn
            self.assertEqual(chc.requests, [])
            (self.root / lease.host_slot_key("chc")).unlink()  # the other holder finishes

        code, out = self.run_main("--checks", "chc", "--samples", "4", client=client_for(chc), slot_sleep=sleep)
        self.assertEqual(code, 0, out)
        self.assertEqual(slept, [lease.OPERATOR_RETRY_S])
        self.assertEqual(len(chc.requests), 12)
        self.assertIn("trying again", self.stderr)
        self.assertIsNone(self.slot())
        self.assertFalse(self.reservation())

    def test_released_when_the_check_stops_on_a_403(self):
        code, _ = self.run_main("--checks", "chc", "--samples", "4", client=client_for(FakeChc(refuse=True)))
        self.assertEqual(code, 1)
        self.assertIsNone(self.slot())

    def test_coverage_and_dynamical_take_no_slot(self):
        with unittest.mock.patch.object(vc.lease, "hold_host_renewed", side_effect=AssertionError("slot taken")):
            code, out = self.run_main("--checks", "coverage,dynamical", "--month", "2024-02", dynamical=FakeDynamical())
        self.assertEqual(code, 0, out)
        self.assertIsNone(self.slot())

    def test_a_lost_slot_stops_the_check_before_its_next_request(self):
        chc = FakeChc()
        res = vc.check_chc(vc.plan_samples(4, 1, SPANS), {p: vc.FinalsArray(vc.CopyStore(self.url), p) for p in vc.FINALS}, client_for(chc), lost=lambda: "taken over")
        self.assertEqual(chc.requests, [])
        self.assertIn("taken over", res.stopped)
        self.assertFalse(res.ok)


class RenewedHold(unittest.TestCase):
    """lease.hold_host_renewed, the operator's open-ended hold on CHC's slot."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.mirror = zarrstore.Mirror.from_url(f"file://{self.root}")
        self.path = self.root / lease.host_slot_key("chc")

    def tearDown(self):
        self.tmp.cleanup()

    def body(self):
        return json.loads(self.path.read_text()) if self.path.exists() else None

    def test_renewed_while_held_and_released_on_ctrl_c(self):
        clock = [1000.0]
        with self.assertRaises(KeyboardInterrupt):
            with lease.hold_host_renewed(self.mirror, "chc", "verify:op@box", hold_s=300, renew_s=0.01, now=lambda: clock[0]) as hold:
                self.assertEqual(self.body()["expires"], 1300.0)
                self.assertEqual(self.body()["holder"], "verify:op@box")
                clock[0] = 2000.0
                wait_for(lambda: (self.body() or {}).get("expires") == 2300.0)
                self.assertIsNone(hold.lost)
                raise KeyboardInterrupt
        self.assertIsNone(self.body())

    def test_lost_when_taken_over(self):
        with lease.hold_host_renewed(self.mirror, "chc", "verify:op@box", renew_s=0.01) as hold:
            self.path.write_text(json.dumps({"owner": "other", "expires": time.time() + 600, "holder": "fetch:x"}))
            wait_for(lambda: hold.lost is not None)
            self.assertIn("no longer ours", hold.lost)
        self.assertEqual(self.body()["owner"], "other")  # never releases another's

    def test_an_expired_slot_is_taken_over(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({"owner": "dead", "expires": 1.0, "holder": "verify:killed@box"}))
        with lease.hold_host_renewed(self.mirror, "chc", "verify:op@box") as hold:
            self.assertEqual(self.body()["owner"], hold.owner)
        self.assertIsNone(self.body())

    def test_a_waiting_backfills_reservation_is_respected(self):
        r = self.root / lease.host_reservation_key("chc")
        r.parent.mkdir(parents=True)
        r.write_text(json.dumps({"owner": "backfill:x", "expires": time.time() + 300, "holder": "ingest:backfill:x"}))
        with self.assertRaises(lease.HostBusy) as e:
            with lease.hold_host_renewed(self.mirror, "chc", "verify:op@box"):
                self.fail("took a reserved slot")
        self.assertIn("ingest:backfill:x", str(e.exception))
        self.assertIsNone(self.body())
        self.assertEqual(json.loads(r.read_text())["owner"], "backfill:x")


class Coverage(unittest.TestCase):
    def doc(self, months, final_through, product="rnl"):
        return {
            "product": product,
            "finalThrough": final_through,
            "files": [{"url": f"https://x/chirps-v3.0.{m.replace('-', '.')}.days_p05.nc"} for m in months],
        }

    TODAY = dt.date(2024, 4, 20)

    def test_contiguous_and_recent_passes(self):
        c = vc.check_coverage(self.doc(["1981-01", "1981-02"], "1981-02-28"), "rnl", dt.date(1981, 4, 1))
        self.assertTrue(c.ok, c.problems)
        self.assertEqual((c.months, c.lag_days), (2, 32))

    def test_a_gap_fails(self):
        c = vc.check_coverage(self.doc(["2024-01", "2024-03"], "2024-01-31"), "rnl", self.TODAY, first_month="2024-01")
        self.assertFalse(c.ok)
        self.assertIn("1 month(s) missing between the first and the last held: 2024-02", c.problems)

    def test_the_first_month_must_be_the_products(self):
        c = vc.check_coverage(self.doc(["2000-07"], "2000-07-31", "sat"), "sat", dt.date(2000, 9, 1))
        self.assertIn("the first month held is 2000-07, not 2000-06", c.problems)

    def test_final_through_must_end_the_contiguous_run(self):
        c = vc.check_coverage(self.doc(["2024-01", "2024-02"], "2024-01-31"), "rnl", self.TODAY, first_month="2024-01")
        self.assertIn("finalThrough 2024-01-31 is not the end of the contiguous months (2024-02-29)", c.problems)

    def test_lag(self):
        c = vc.check_coverage(self.doc(["2024-01"], "2024-01-31"), "rnl", dt.date(2024, 4, 16), first_month="2024-01")
        self.assertEqual(c.lag_days, 76)
        self.assertFalse(c.ok)
        self.assertTrue(vc.check_coverage(self.doc(["2024-01"], "2024-01-31"), "rnl", dt.date(2024, 4, 15), first_month="2024-01").ok)

    def test_no_manifest_fails(self):
        self.assertFalse(vc.check_coverage(None, "rnl", self.TODAY).ok)

    def test_the_committed_fixture_copy_offline(self):
        url = f"file://{HERE.parent / 'backend' / 'fixtures' / 'mirror'}"
        for first, want in ((["--first-month", "2023-01"], 0), ([], 1)):
            out = io.StringIO()
            with redirect_stdout(out), redirect_stderr(io.StringIO()):
                code = vc.main(["--mirror", url, "--no-network", "--today", "2026-01-20", *first])
            self.assertEqual(code, want, out.getvalue())


class DynamicalComparison(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(3)
        self.copy = rng.gamma(0.6, 6.0, size=(4, 6, 5)).astype(np.float32)
        self.copy[:, :2, :] = np.nan  # the south rows are sea: the mask is not symmetric
        # dynamical.org's: kg m-2 s-1, north-up, off by up to 0.15%
        jitter = 1 + rng.uniform(-0.0015, 0.0015, size=self.copy.shape).astype(np.float32)
        self.raw = ((self.copy * jitter) / np.float32(86400))[:, ::-1, :].astype(np.float32)

    def test_units_and_row_flip(self):
        mm = vc.dynamical_to_copy(self.raw)
        r = vc.compare_dynamical("2024-06", self.copy, mm)
        self.assertTrue(r.ok, r.problems)
        self.assertEqual(r.mask_mismatch, 0)
        self.assertLess(r.max, 0.002)
        self.assertGreater(r.wet, 0)

    def test_without_the_flip_the_mask_fails(self):
        r = vc.compare_dynamical("2024-06", self.copy, (self.raw * np.float32(86400)).astype(np.float32))
        self.assertFalse(r.ok)
        self.assertGreater(r.mask_mismatch, 0)

    def test_without_the_units_it_fails(self):
        r = vc.compare_dynamical("2024-06", self.copy, self.raw[:, ::-1, :].copy())
        self.assertFalse(r.ok)
        self.assertGreater(r.max, 0.99)

    def test_a_mask_difference_fails(self):
        mm = vc.dynamical_to_copy(self.raw)
        mm[0, 5, 0] = np.nan
        r = vc.compare_dynamical("2024-06", self.copy, mm)
        self.assertEqual(r.mask_mismatch, 1)
        self.assertFalse(r.ok)

    def test_the_tolerance(self):
        mm = self.copy.copy()
        i = np.argwhere(self.copy >= 1)[0]
        mm[tuple(i)] = self.copy[tuple(i)] * np.float32(1.0019)
        self.assertTrue(vc.compare_dynamical("m", self.copy, mm).ok)
        mm[tuple(i)] = self.copy[tuple(i)] * np.float32(1.0025)
        r = vc.compare_dynamical("m", self.copy, mm)
        self.assertFalse(r.ok)
        self.assertIn("over 0.200%", r.problems[0])

    def test_dry_cells_do_not_count_toward_the_relative_difference(self):
        copy = np.full((1, 2, 2), 0.5, dtype=np.float32)
        copy[0, 0, 0] = 10.0
        mm = copy * np.float32(1.5)
        mm[0, 0, 0] = 10.0
        r = vc.compare_dynamical("m", copy, mm)
        self.assertTrue(r.ok, r.problems)
        self.assertEqual(r.wet, 1)

    def test_nothing_wet_fails(self):
        z = np.zeros((1, 2, 2), dtype=np.float32)
        self.assertFalse(vc.compare_dynamical("m", z, z).ok)

    def test_one_whole_month_per_decade_seeded(self):
        months = vc.pick_months(dt.date(1981, 1, 1), dt.date(2026, 8, 31), 604)
        self.assertEqual([y // 10 for y, _ in months], [198, 199, 200, 201, 202])
        self.assertEqual(months, vc.pick_months(dt.date(1981, 1, 1), dt.date(2026, 8, 31), 604))
        self.assertEqual(vc.pick_months(dt.date(2024, 1, 15), dt.date(2024, 3, 30), 1), [(2024, 2)])


class FakeDynamical:
    """dynamical.org's store over the copy's own February (north-up, kg m-2 s-1), times `scale`."""

    def __init__(self, scale=np.float32(1.0)):
        self.scale = scale

    def first_day(self):
        return dt.date(1981, 1, 1)

    def last_day(self):
        return dt.date(2026, 6, 30)

    def month(self, y, m):
        assert (y, m) == (2024, 2)
        v = np.stack([copy_values("rnl", dt.date(2024, 2, d)) for d in range(1, 30)]) * self.scale
        return (v / np.float32(86400))[:, ::-1, :]


class AgainstDynamical(CopyTest):
    def test_main_reads_the_region_from_the_copy(self):
        code, out = self.run_main("--checks", "dynamical", "--month", "2024-02", dynamical=FakeDynamical())
        self.assertEqual(code, 0, out)
        self.assertIn("| 2024-02 |", out)

    def test_main_picks_february_itself_and_fails_beyond_tolerance(self):
        code, out = self.run_main("--checks", "dynamical", dynamical=FakeDynamical(np.float32(1.01)))
        self.assertEqual(code, 1)
        self.assertIn("over 0.200%", out)


if __name__ == "__main__":
    unittest.main()
