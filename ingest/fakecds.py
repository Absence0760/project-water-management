"""A stand-in for the Copernicus CDS (fixtures mode, tests): no network, no key.

It has era5land.LiveCds's four calls: `submit`, `status`, `find`,
`download`. A job id names its month and variant (`fake-YYYY-MM-<n>`), so a
fresh FakeCds (a later `pnpm dev:ingest:run era5l`, another process) still
recognises a request an earlier one queued: an id it never saw counts as
done. Downloads are written by fixtures/era5land/make_era5land_fixture.py;
`FakeAgera5Cds` answers agera5.py's AgERA5 requests the same way from
fixtures/agera5/make_agera5_fixture.py, and `FakeC3sCds` c3s_seasonal.py's
seasonal requests (issue #620) from fixtures/c3s/make_c3s_fixture.py, its
job ids naming the request key instead of a month.

Tests script the queue: `ready_after` polls before a job is done, `fail`
months whose jobs end `failed`, `refuse` a status (401/403) every call
raises as polite.StopRun, and they read `calls` and `submits`. Not shipped
in the Lambda image.
"""

from __future__ import annotations

import datetime as dt
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "era5land"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "agera5"))
sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "c3s"))

import agera5request  # noqa: E402
import c3srequest  # noqa: E402
import cdsjob  # noqa: E402
import era5request  # noqa: E402
import make_agera5_fixture as afx  # noqa: E402
import make_c3s_fixture as cfx  # noqa: E402
import make_era5land_fixture as fx  # noqa: E402
import polite  # noqa: E402

_ID = re.compile(r"^fake-(\d{4})-(\d{2})-(\d+)$")


class FakeCds:
    #: The request module whose requests this fake answers (DATASET, PRODUCT, month_request, request_month): never the
    #: job itself, which imports this fake (era5request.py, agera5request.py).
    job = era5request

    def __init__(self, variant: str | None = None, today: dt.date | None = None, ready_after: int = 0, fail=(), refuse: int | None = None, preliminary=None, values=None):
        self.variant = variant  # "revised": the consolidated values differ at one point
        self.today = today or dt.date.today()
        self.ready_after = ready_after
        self.fail = set(fail)  # months ("YYYY-MM") whose jobs end failed
        self.refuse = refuse
        self.preliminary = preliminary  # a callable (y, m) -> bool, or None for a file without expver; default: months ending under 75 days ago
        self.values = values  # make_era5land_fixture.write_month's values hook
        self.jobs: dict[str, dict] = {}
        self.calls: list[tuple] = []
        self.submits: list[str] = []

    def _gate(self, what, *args):
        self.calls.append((what, *args))
        if self.refuse:
            raise polite.StopRun(f"{cdsjob.CDS_URL} ({what})", self.refuse)

    def submit(self, dataset, request) -> str:
        self._gate("submit", dataset)
        if dataset != self.job.DATASET:
            raise cdsjob.CdsError(f"no dataset {dataset}")
        ym = self.job.request_month(request)
        if ym is None or request != self.job.month_request(ym):
            raise cdsjob.CdsError(f"not a {self.job.PRODUCT} month request: {request}")
        key = cdsjob.month_str(ym)
        n = sum(1 for s in self.submits if s == key) + 1
        rid = f"fake-{key}-{n}"
        self.submits.append(key)
        self.jobs[rid] = {"month": ym, "polls": 0}
        return rid

    def status(self, rid) -> str:
        self._gate("status", rid)
        m = _ID.match(rid)
        if not m:
            return "missing"
        job = self.jobs.get(rid)
        if job is None:
            return "successful"  # queued by an earlier process: done by now
        job["polls"] += 1
        if f"{m[1]}-{m[2]}" in self.fail:
            return "failed"
        return "successful" if job["polls"] > self.ready_after else "running"

    def find(self, dataset, ym):
        self._gate("find", dataset)
        key = era5request.month_str(ym)
        for rid, job in self.jobs.items():
            if job["month"] == tuple(ym) and key not in self.fail:
                return rid
        return None

    def _preliminary(self, ym) -> bool | None:
        if self.preliminary is not None:
            p = self.preliminary(*ym)
            return None if p is None else bool(p)
        return (self.today - era5request.month_end(ym)).days < era5request.RECHECK_AFTER_DAYS

    def download(self, rid, dest) -> int:
        self._gate("download", rid)
        m = _ID.match(rid)
        ym = (int(m[1]), int(m[2]))
        prelim = self._preliminary(ym)
        fx.write_month(dest, *ym, revised=(self.variant == "revised" and not prelim), preliminary=prelim, values=self.values)
        return Path(dest).stat().st_size


class FakeAgera5Cds(FakeCds):
    """The same queue for AgERA5 (agera5.py): `sis-agrometeorological-indicators`
    month requests, answered with fixtures/agera5's synthetic zip of daily
    NetCDF files. Its files never say their phase (AgERA5's don't), so
    `preliminary` is ignored. `values(day, i, j)` (mm) replaces the fixture's;
    `variant="revised"` moves one cell; `single=True` writes one NetCDF; `lattice="corners"` x.x0 points."""

    def __init__(self, *a, single: bool = False, lattice: str = "centres", **kw):
        super().__init__(*a, **kw)
        self.job = agera5request
        self.single = single
        self.lattice = lattice

    def download(self, rid, dest) -> int:
        self._gate("download", rid)
        m = _ID.match(rid)
        afx.write_month(dest, int(m[1]), int(m[2]), revised=self.variant == "revised", single=self.single, lattice=self.lattice, values=self.values)
        return Path(dest).stat().st_size


_C3S_ID = re.compile(r"^fake-c3s-(fc|hc)~([a-z_]+-\d+)~(\d{4}-\d{2}|\d{2})-(\d+)$")


class FakeC3sCds(FakeCds):
    """The same queue for C3S's seasonal forecasts (c3s_seasonal.py):
    `seasonal-original-single-levels` requests, one system's init or
    hindcast month each, answered with fixtures/c3s's synthetic GRIB. A job
    id names its key (`fake-c3s-fc~ecmwf-51~2026-10-1`), so a later process
    still recognises it. `fail` holds request keys as strings
    (`fc/ecmwf-51/2026-10`); `members` (an int, or a dict by system), `leads`
    (a count), `years` (the hindcast years served) and `values`/`skip` go to
    make_c3s_fixture.write_request. `variant="revised"` adds 0.5 mm to every
    day of the ecmwf-51 forecast (a forecast collected twice that came back
    different). Defaults are dev's: every lead, 2-3 members, three hindcast years."""

    def __init__(self, *a, members=None, leads: int | None = None, years=None, skip=None, **kw):
        super().__init__(*a, **kw)
        self.job = c3srequest
        self.members = members
        self.leads = leads
        self.years = years
        self.skip = skip

    def submit(self, dataset, request) -> str:
        self._gate("submit", dataset)
        if dataset != c3srequest.DATASET:
            raise cdsjob.CdsError(f"no dataset {dataset}")
        key = c3srequest.request_key(request)
        if key is None or request != c3srequest.request(key):
            raise cdsjob.CdsError(f"not a c3s request: {request}")
        ks = c3srequest.key_str(key)
        n = sum(1 for s in self.submits if s == ks) + 1
        rid = f"fake-c3s-{key[0]}~{key[1]}~{key[2]}-{n}"
        self.submits.append(ks)
        self.jobs[rid] = {"key": key, "polls": 0}
        return rid

    def status(self, rid) -> str:
        self._gate("status", rid)
        m = _C3S_ID.match(rid)
        if not m:
            return "missing"
        job = self.jobs.get(rid)
        if job is None:
            return "successful"
        job["polls"] += 1
        if "/".join(m.groups()[:3]) in self.fail:
            return "failed"
        return "successful" if job["polls"] > self.ready_after else "running"

    def find(self, dataset, key):
        self._gate("find", dataset)
        for rid, job in self.jobs.items():
            if job["key"] == tuple(key) and c3srequest.key_str(job["key"]) not in self.fail:
                return rid
        return None

    def download(self, rid, dest) -> int:
        self._gate("download", rid)
        m = _C3S_ID.match(rid)
        key = tuple(m.groups()[:3])
        values = self.values
        if values is None and self.variant == "revised" and key[0] == "fc" and key[1] == "ecmwf-51":
            values = lambda *a: cfx.daily_mm(*a) + 0.5  # noqa: E731
        cfx.write_request(dest, key, members=self.members, leads=self.leads, years=self.years, values=values, skip=self.skip)
        return Path(dest).stat().st_size
