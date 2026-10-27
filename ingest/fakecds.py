"""A stand-in for the Copernicus CDS (fixtures mode, tests): no network, no key.

It has era5land.LiveCds's four calls: `submit`, `status`, `find`,
`download`. A job id names its month and variant (`fake-YYYY-MM-<n>`), so a
fresh FakeCds (a later `pnpm dev:ingest:run era5l`, another process) still
recognises a request an earlier one queued: an id it never saw counts as
done. Downloads are written by fixtures/era5land/make_era5land_fixture.py;
`FakeAgera5Cds` answers agera5.py's AgERA5 requests the same way from
fixtures/agera5/make_agera5_fixture.py.

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

import agera5request  # noqa: E402
import cdsjob  # noqa: E402
import era5request  # noqa: E402
import make_agera5_fixture as afx  # noqa: E402
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
            raise polite.StopRun(f"{era5request.CDS_URL} ({what})", self.refuse)

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
