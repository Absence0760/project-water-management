"""A stand-in for the Copernicus CDS (fixtures mode, tests): no network, no key.

It has era5land.LiveCds's four calls: `submit`, `status`, `find`,
`download`. A job id names its month and variant (`fake-YYYY-MM-<n>`), so a
fresh FakeCds (a later `pnpm dev:ingest:run era5l`, another process) still
recognises a request an earlier one queued: an id it never saw counts as
done. Downloads are written by fixtures/era5land/make_era5land_fixture.py.

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

import era5land  # noqa: E402
import make_era5land_fixture as fx  # noqa: E402
import polite  # noqa: E402

_ID = re.compile(r"^fake-(\d{4})-(\d{2})-(\d+)$")


class FakeCds:
    def __init__(self, variant: str | None = None, today: dt.date | None = None, ready_after: int = 0, fail=(), refuse: int | None = None, preliminary=None, values=None):
        self.variant = variant  # "revised": the consolidated values differ at one point
        self.today = today or dt.date.today()
        self.ready_after = ready_after
        self.fail = set(fail)  # months ("YYYY-MM") whose jobs end failed
        self.refuse = refuse
        self.preliminary = preliminary  # a callable (y, m) -> bool; default: months ending under 75 days ago
        self.values = values  # make_era5land_fixture.write_month's values hook
        self.jobs: dict[str, dict] = {}
        self.calls: list[tuple] = []
        self.submits: list[str] = []

    def _gate(self, what, *args):
        self.calls.append((what, *args))
        if self.refuse:
            raise polite.StopRun(f"{era5land.CDS_URL} ({what})", self.refuse)

    def submit(self, dataset, request) -> str:
        self._gate("submit", dataset)
        if dataset != era5land.DATASET:
            raise era5land.CdsError(f"no dataset {dataset}")
        ym = era5land.request_month(request)
        if ym is None or request != era5land.month_request(ym):
            raise era5land.CdsError(f"not an era5l month request: {request}")
        key = era5land.month_str(ym)
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
        key = era5land.month_str(ym)
        for rid, job in self.jobs.items():
            if job["month"] == tuple(ym) and key not in self.fail:
                return rid
        return None

    def _preliminary(self, ym) -> bool:
        if self.preliminary is not None:
            return bool(self.preliminary(*ym))
        return (self.today - era5land.month_end(ym)).days < era5land.RECHECK_AFTER_DAYS

    def download(self, rid, dest) -> int:
        self._gate("download", rid)
        m = _ID.match(rid)
        ym = (int(m[1]), int(m[2]))
        prelim = self._preliminary(ym)
        fx.write_month(dest, *ym, revised=(self.variant == "revised" and not prelim), preliminary=prelim, values=self.values)
        return Path(dest).stat().st_size
