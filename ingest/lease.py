"""One writer per product at a time (issue #604 R2-A).

A finals chunk holds a whole year (D2: chunk (1, 366, 20, 20)), and a write
stages the year's chunks, changes some days and uploads them back
(zarrstore.S3Mirror.stage). Two runs writing two months of the same year at
once would each upload the year's chunks with only their own month changed,
and the later upload would silently put the other month's old values back,
under a manifest that says the new ones are held. A conditional put on the
manifest alone (If-Match) would come too late: the chunks are already up by
then. So each run takes a **lease** on its product before it reads anything:

- S3: `ingest-state/<product>/lease.json`, created with `If-None-Match: *`
  (S3 conditional writes), holding an owner token and an expiry. A lease
  past its expiry (a run that died without releasing it) is taken over with
  `If-Match` on its ETag, so two runs can't both take it over.
- A local copy (dev, tests): the same file created with O_EXCL.

The expiry is 20 minutes, longer than Lambda's 15-minute maximum, so a
running Lambda's lease never expires under it. A run that finds the lease
held raises `MirrorBusy`: the daily monthly run then ends quietly (the
backfill holding it is doing the same work), and a backfill invocation fails
with that error name so the Step Functions map can wait and retry it.

**The CHC request slot** (`hold_host`): CHC asked (2026-10-27) for one file at
a time and about 1 request a second **in total across all our Lambdas**. This
job and the Node fetcher Lambda (backend/src/feeds/hostSlot.ts) both ask CHC,
so before either asks anything it takes one shared lease,
`ingest-state/hosts/chc/lease.json`, by the same conditional writes as a
product's. Its expiry is the holder's own hard deadline (the Lambda's time
left) plus HOST_SLOT_MARGIN_S, so a run killed by its timeout frees the slot
a minute later, and no renewal is needed: a Lambda can't run past its
deadline. Busy raises `HostBusy` (a MirrorBusy): the daily run ends quietly
(tomorrow's catches up) and a backfill month fails with that name, which the
state machine's own retrier waits out (infra/ingest_backfill.tf). The body
the Node side writes and reads is the same JSON: {"owner", "expires"
(epoch seconds), "holder"}.
"""

from __future__ import annotations

import contextlib
import json
import os
import time
import uuid
from typing import Callable

import zarrstore

LEASE_SECONDS = 20 * 60
# The CHC slot's expiry past its holder's deadline; with no deadline (a local
# run, a test) the holder is given Lambda's longest run, 15 minutes.
HOST_SLOT_MARGIN_S = 60
HOST_SLOT_DEFAULT_S = 15 * 60
HOSTS = ("chc",)


class MirrorBusy(Exception):
    """Another run holds this product's lease."""


class HostBusy(MirrorBusy):
    """Another process (this job or the fetcher Lambda) holds a source host's request slot."""


def lease_key(product: str) -> str:
    return f"ingest-state/{product}/lease.json"


def host_slot_key(host: str) -> str:
    if host not in HOSTS:
        raise ValueError(f"no request slot for host {host!r}")
    return f"ingest-state/hosts/{host}/lease.json"


def _body(owner: str, now: float, seconds: float = LEASE_SECONDS, holder: str | None = None) -> bytes:
    body = {"owner": owner, "expires": now + seconds}
    if holder:
        body["holder"] = holder
    return (json.dumps(body) + "\n").encode()


def _error_code(e: Exception) -> str | None:
    return getattr(e, "response", {}).get("Error", {}).get("Code")


_CONFLICT = {"PreconditionFailed", "ConditionalRequestConflict"}


class _Lease:
    """What one lease is: its key, its name in messages, the error a held one raises, and the body to write."""

    def __init__(self, rel_key: str, label: str, busy: type[MirrorBusy], seconds: float = LEASE_SECONDS, holder: str | None = None):
        self.rel_key = rel_key
        self.label = label
        self.busy = busy
        self.seconds = seconds
        self.holder = holder

    def body(self, owner: str, now: float) -> bytes:
        return _body(owner, now, self.seconds, self.holder)


def _until(held: dict) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(held["expires"]))


def _acquire_s3(m: zarrstore.S3Mirror, ls: _Lease, owner: str, now: float) -> None:
    key = m._key(ls.rel_key)
    try:
        m.client.put_object(Bucket=m.bucket, Key=key, Body=ls.body(owner, now), IfNoneMatch="*", ContentType="application/json")
        return
    except Exception as e:
        if _error_code(e) not in _CONFLICT:
            raise
    try:
        got = m.client.get_object(Bucket=m.bucket, Key=key)
    except m.client.exceptions.NoSuchKey:
        # Released between our put and this read: try once more from the start.
        try:
            m.client.put_object(Bucket=m.bucket, Key=key, Body=ls.body(owner, now), IfNoneMatch="*", ContentType="application/json")
            return
        except Exception as e:
            if _error_code(e) in _CONFLICT:
                raise ls.busy(f"another run took the {ls.label}") from None
            raise
    held = json.loads(got["Body"].read())
    if held.get("expires", 0) > now:
        raise ls.busy(f"another run ({held.get('holder') or held.get('owner')}) holds the {ls.label} until {_until(held)}")
    try:
        m.client.put_object(Bucket=m.bucket, Key=key, Body=ls.body(owner, now), IfMatch=got["ETag"], ContentType="application/json")
    except Exception as e:
        if _error_code(e) in _CONFLICT:
            raise ls.busy(f"another run took over the expired {ls.label} first") from None
        raise


def _release_s3(m: zarrstore.S3Mirror, ls: _Lease, owner: str) -> None:
    key = m._key(ls.rel_key)
    try:
        held = json.loads(m.client.get_object(Bucket=m.bucket, Key=key)["Body"].read())
    except m.client.exceptions.NoSuchKey:
        return
    # Ours unless it expired and was taken over, which a Lambda can't outlive.
    if held.get("owner") == owner:
        m.client.delete_object(Bucket=m.bucket, Key=key)


def _acquire_local(m: zarrstore.LocalMirror, ls: _Lease, owner: str, now: float) -> None:
    path = m.root / ls.rel_key
    path.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)  # owner only: nothing else on the machine reads it
        except FileExistsError:
            held = json.loads(path.read_text() or "{}")
            if held.get("expires", 0) > now:
                raise ls.busy(f"another run ({held.get('holder') or held.get('owner')}) holds the {ls.label}") from None
            path.unlink(missing_ok=True)
            continue
        with os.fdopen(fd, "wb") as f:
            f.write(ls.body(owner, now))
        return
    raise ls.busy(f"another run took the {ls.label}")


def _release_local(m: zarrstore.LocalMirror, ls: _Lease, owner: str) -> None:
    path = m.root / ls.rel_key
    try:
        held = json.loads(path.read_text())
    except FileNotFoundError:
        return
    if held.get("owner") == owner:
        path.unlink(missing_ok=True)


@contextlib.contextmanager
def _hold(mirror: zarrstore.Mirror, ls: _Lease, now: Callable[[], float]):
    owner = uuid.uuid4().hex
    if isinstance(mirror, zarrstore.S3Mirror):
        acquire, release = _acquire_s3, _release_s3
    elif isinstance(mirror, zarrstore.LocalMirror):
        acquire, release = _acquire_local, _release_local
    else:
        raise TypeError(f"no lease for {type(mirror).__name__}")
    acquire(mirror, ls, owner, now())
    try:
        yield owner
    finally:
        release(mirror, ls, owner)


def hold(mirror: zarrstore.Mirror, product: str, now: Callable[[], float] = time.time):
    """Hold `product`'s lease for the block; raise MirrorBusy if another run has it."""
    return _hold(mirror, _Lease(lease_key(product), f"{product} lease", MirrorBusy), now)


def hold_host(mirror: zarrstore.Mirror, host: str, remaining_s: float | None, holder: str, now: Callable[[], float] = time.time):
    """Hold `host`'s request slot (shared with the fetcher Lambda) for the block; raise HostBusy if anyone has it.

    `remaining_s`: the holder's time left (the Lambda's), or None without a
    deadline; the slot expires that long plus HOST_SLOT_MARGIN_S from now."""
    seconds = (HOST_SLOT_DEFAULT_S if remaining_s is None else max(0.0, remaining_s)) + HOST_SLOT_MARGIN_S
    return _hold(mirror, _Lease(host_slot_key(host), f"{host} request slot", HostBusy, seconds, holder), now)
