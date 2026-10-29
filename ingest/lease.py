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

**A backfill keeps the slot for its whole run** (`hold_host_for_backfill`,
issue #618 step 4). A backfill execution asks CHC one month per invocation,
with at least a minute's pause between them, and the fetcher's per-feed
crawl (~10-minute fetches back to back) would take the slot in every pause:
a month retrying HostBusy every 2 minutes rarely won it. So every month of
one execution takes the slot as owner `backfill:<execution id>` (holder
`ingest:backfill:<execution name>`), recognises the slot as its own when an
earlier month of the same execution left it, and on its way out keeps it
through the pause (expiry: now + the pause + BACKFILL_HOLD_MARGIN_S) instead
of releasing it. The state machine's last step, reached on success and on
failure alike, releases it (`release_backfill_hold`, the handler's
`{"mode": "release_hold"}` event); an execution stopped by hand, or a month
that dies, leaves a hold that expires on its own within the margin. While it
holds the slot the fetcher's fetches defer and re-queue themselves, and the
daily rnl/sat runs end quietly, as for any holder.

**The reservation** (`ingest-state/hosts/<host>/reserved.json`, the same
JSON): the first month of an execution still has to win the slot from a
running crawl. A backfill month that finds the slot held by someone else
reserves the next turn for RESERVATION_S (each retry renews it), and any
other taker (this module's, and the Node side's) that takes a free slot while
someone else's reservation is live lets it go again at once and answers busy.
The backfill deletes its reservation once it holds the slot. A reservation
only ever makes others wait a turn; it is advisory (the Node side ignores one
it can't read), and the slot itself is what keeps CHC to one process.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import time
import uuid
from typing import Callable

import zarrstore

log = logging.getLogger("ingest")

LEASE_SECONDS = 20 * 60
# The CHC slot's expiry past its holder's deadline; with no deadline (a local
# run, a test) the holder is given Lambda's longest run, 15 minutes.
HOST_SLOT_MARGIN_S = 60
HOST_SLOT_DEFAULT_S = 15 * 60
HOSTS = ("chc",)
# A backfill's hold past the pause between its months: the state machine's
# transitions, a cold start and its Lambda service-error retries fit in it, so
# the next month of the same execution finds the hold still its own.
BACKFILL_HOLD_MARGIN_S = 5 * 60
# A waiting backfill's reservation of the next turn: longer than the state
# machine's HostBusy retry interval (120 s, infra/ingest_backfill.tf), so each
# retry renews it before it lapses.
RESERVATION_S = 5 * 60
# A Step Functions execution ARN (or a plain id locally); its last part is the execution's name.
_EXECUTION = re.compile(r"^[A-Za-z0-9:_./-]{1,256}$")


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


def host_reservation_key(host: str) -> str:
    """The next turn at `host`'s slot, reserved by a waiting backfill (backend/src/feeds/hostSlot.ts reads the same key)."""
    if host not in HOSTS:
        raise ValueError(f"no request slot for host {host!r}")
    return f"ingest-state/hosts/{host}/reserved.json"


def valid_execution(execution) -> bool:
    return isinstance(execution, str) and bool(_EXECUTION.match(execution)) and bool(execution.rsplit(":", 1)[-1])


def backfill_owner(execution: str) -> str:
    """The slot's owner for every month of one backfill execution: the same across its invocations."""
    return f"backfill:{execution}"


def backfill_holder(execution: str) -> str:
    """The name the hold goes by (the fetcher's deferral log shows it): the execution's name, not its whole ARN."""
    return f"ingest:backfill:{execution.rsplit(':', 1)[-1]}"[:80]


def _body(owner: str, now: float, seconds: float = LEASE_SECONDS, holder: str | None = None) -> bytes:
    body = {"owner": owner, "expires": now + seconds}
    if holder:
        body["holder"] = holder
    return (json.dumps(body) + "\n").encode()


def _error_code(e: Exception) -> str | None:
    return getattr(e, "response", {}).get("Error", {}).get("Code")


_CONFLICT = {"PreconditionFailed", "ConditionalRequestConflict"}


# --- One small JSON object, by conditional writes ------------------------------
# S3: If-None-Match: * to create, If-Match on the ETag to replace. A local copy
# (dev, tests): O_EXCL to create, the content's hash as its ETag; replacing is
# read then write there, not atomic, which locally means two dev processes at
# worst (backend/src/feeds/hostSlot.ts FileSlots says the same).


def _parse(data: bytes) -> dict:
    try:
        v = json.loads(data or b"{}")
    except ValueError:
        return {}  # a torn or foreign body is no holder: treated as expired
    return v if isinstance(v, dict) else {}


def _read(m: zarrstore.Mirror, rel: str) -> tuple[dict, str] | None:
    """The object and its ETag, or None when there is none."""
    if isinstance(m, zarrstore.S3Mirror):
        try:
            got = m.client.get_object(Bucket=m.bucket, Key=m._key(rel))
        except m.client.exceptions.NoSuchKey:
            return None
        return _parse(got["Body"].read()), got["ETag"]
    path = m.root / rel
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None
    return _parse(data), hashlib.md5(data).hexdigest()


def _put(m: zarrstore.Mirror, rel: str, body: bytes, if_match: str | None = None) -> bool:
    """Create the object (if_match None) or replace the one with that ETag; False when someone got there first."""
    if isinstance(m, zarrstore.S3Mirror):
        cond = {"IfNoneMatch": "*"} if if_match is None else {"IfMatch": if_match}
        try:
            m.client.put_object(Bucket=m.bucket, Key=m._key(rel), Body=body, ContentType="application/json", **cond)
            return True
        except Exception as e:
            if _error_code(e) in _CONFLICT:
                return False
            raise
    path = m.root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if if_match is None:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)  # owner only: nothing else on the machine reads it
        except FileExistsError:
            return False
    else:
        got = _read(m, rel)
        if got is None or got[1] != if_match:
            return False
        fd = os.open(path, os.O_WRONLY | os.O_TRUNC)
    with os.fdopen(fd, "wb") as f:
        f.write(body)
    return True


def _delete(m: zarrstore.Mirror, rel: str) -> None:
    if isinstance(m, zarrstore.S3Mirror):
        m.client.delete_object(Bucket=m.bucket, Key=m._key(rel))
    else:
        (m.root / rel).unlink(missing_ok=True)


def _check_backend(m: zarrstore.Mirror) -> None:
    if not isinstance(m, (zarrstore.S3Mirror, zarrstore.LocalMirror)):
        raise TypeError(f"no lease for {type(m).__name__}")


class _Lease:
    """One lease: its key, its name in messages, the error a held one raises, the body to write, and (a host slot) its reservation."""

    def __init__(self, rel_key: str, label: str, busy: type[MirrorBusy], seconds: float = LEASE_SECONDS, holder: str | None = None, reservation: str | None = None, reserve: bool = False):
        self.rel_key = rel_key
        self.label = label
        self.busy = busy
        self.seconds = seconds
        self.holder = holder
        # Where others' reservations are read from (a host slot), and whether this holder reserves the next turn when it has to wait (a backfill).
        self.reservation = reservation
        self.reserve = reserve

    def body(self, owner: str, now: float) -> bytes:
        return _body(owner, now, self.seconds, self.holder)


def _until(held: dict) -> str:
    e = held.get("expires", 0)
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(e if isinstance(e, (int, float)) else 0))


def _live(held: dict, now: float) -> bool:
    e = held.get("expires", 0)
    return isinstance(e, (int, float)) and e > now


def _reserve(m: zarrstore.Mirror, ls: _Lease, owner: str, now: float) -> bool:
    """Reserve the next turn (or renew our reservation); False when another waiter's is live."""
    body = _body(owner, now, RESERVATION_S, ls.holder)
    if _put(m, ls.reservation, body):
        return True
    got = _read(m, ls.reservation)
    if got is None:
        return _put(m, ls.reservation, body)
    held, etag = got
    if held.get("owner") == owner or not _live(held, now):
        return _put(m, ls.reservation, body, if_match=etag)
    return False


def _acquire(m: zarrstore.Mirror, ls: _Lease, owner: str, now: float) -> str:
    """Take the lease: "taken" (it was free), "took over" (expired) or "renewed" (already ours: a backfill's earlier month). Raises ls.busy."""
    how = "taken"
    if not _put(m, ls.rel_key, ls.body(owner, now)):
        got = _read(m, ls.rel_key)
        if got is None:
            # Released between our put and this read: try once more from the start.
            if not _put(m, ls.rel_key, ls.body(owner, now)):
                raise ls.busy(f"another run took the {ls.label}")
        else:
            held, etag = got
            ours = held.get("owner") == owner
            if not ours and _live(held, now):
                reserved = ls.reserve and _reserve(m, ls, owner, now)
                raise ls.busy(f"another run ({held.get('holder') or held.get('owner')}) holds the {ls.label} until {_until(held)}" + ("; reserved the next turn" if reserved else ""))
            if not _put(m, ls.rel_key, ls.body(owner, now), if_match=etag):
                raise ls.busy(f"another run took over the expired {ls.label} first")
            how = "renewed" if ours else "took over"
    if ls.reservation is None:
        return how
    got = _read(m, ls.reservation)
    if got is None:
        return how
    r = got[0]
    if r.get("owner") == owner:
        _delete(m, ls.reservation)  # our turn came: the reservation has done its work
    elif _live(r, now) and how != "renewed":
        # A waiting backfill reserved this turn: let the slot go again, and wait ours.
        _release(m, ls, owner)
        raise ls.busy(f"{r.get('holder') or r.get('owner')} reserved the {ls.label} until {_until(r)}")
    return how


def _release(m: zarrstore.Mirror, ls: _Lease, owner: str) -> bool:
    got = _read(m, ls.rel_key)
    # Ours unless it expired and was taken over, which a Lambda can't outlive.
    if got is None or got[0].get("owner") != owner:
        return False
    _delete(m, ls.rel_key)
    return True


def _renew(m: zarrstore.Mirror, ls: _Lease, owner: str, now: float) -> bool:
    """Move our lease's expiry to now + ls.seconds; False when it is no longer ours."""
    got = _read(m, ls.rel_key)
    if got is None or got[0].get("owner") != owner:
        return False
    return _put(m, ls.rel_key, ls.body(owner, now), if_match=got[1])


@contextlib.contextmanager
def _hold(mirror: zarrstore.Mirror, ls: _Lease, now: Callable[[], float]):
    _check_backend(mirror)
    owner = uuid.uuid4().hex
    _acquire(mirror, ls, owner, now())
    try:
        yield owner
    finally:
        _release(mirror, ls, owner)


def hold(mirror: zarrstore.Mirror, product: str, now: Callable[[], float] = time.time):
    """Hold `product`'s lease for the block; raise MirrorBusy if another run has it."""
    return _hold(mirror, _Lease(lease_key(product), f"{product} lease", MirrorBusy), now)


def _host_seconds(remaining_s: float | None) -> float:
    return HOST_SLOT_DEFAULT_S if remaining_s is None else max(0.0, remaining_s)


def hold_host(mirror: zarrstore.Mirror, host: str, remaining_s: float | None, holder: str, now: Callable[[], float] = time.time):
    """Hold `host`'s request slot (shared with the fetcher Lambda) for the block; raise HostBusy if anyone has it or a waiting backfill reserved it.

    `remaining_s`: the holder's time left (the Lambda's), or None without a
    deadline; the slot expires that long plus HOST_SLOT_MARGIN_S from now."""
    seconds = _host_seconds(remaining_s) + HOST_SLOT_MARGIN_S
    return _hold(mirror, _Lease(host_slot_key(host), f"{host} request slot", HostBusy, seconds, holder, reservation=host_reservation_key(host)), now)


@contextlib.contextmanager
def hold_host_for_backfill(mirror: zarrstore.Mirror, host: str, remaining_s: float | None, execution: str, pause_s: float, now: Callable[[], float] = time.time):
    """Hold `host`'s slot for one month of backfill execution `execution`, and keep it through the pause after.

    Taken (or renewed, when an earlier month of the same execution holds it)
    until this invocation's deadline plus the pause plus BACKFILL_HOLD_MARGIN_S;
    on the way out, success or failure, its expiry moves to now + the pause +
    the margin, so the next month finds it still its own. Held by anyone
    else: reserve the next turn and raise HostBusy. Released only by
    release_backfill_hold, at the end of the execution."""
    _check_backend(mirror)
    if not valid_execution(execution):
        raise ValueError(f"not an execution id: {execution!r}")
    owner, holder = backfill_owner(execution), backfill_holder(execution)
    keep = max(0.0, pause_s) + BACKFILL_HOLD_MARGIN_S
    ls = _Lease(host_slot_key(host), f"{host} request slot", HostBusy, _host_seconds(remaining_s) + keep, holder, reservation=host_reservation_key(host), reserve=True)
    t = now()
    how = _acquire(mirror, ls, owner, t)
    log.info("%s: %s the %s for the backfill, until %s", holder, how, ls.label, _until({"expires": t + ls.seconds}))
    try:
        yield owner
    finally:
        ls.seconds = keep
        t = now()
        try:
            if _renew(mirror, ls, owner, t):
                log.info("%s: kept the %s through the pause, until %s", holder, ls.label, _until({"expires": t + keep}))
            else:
                log.warning("%s: the %s is no longer ours (it expired and was taken over); the next month takes it again", holder, ls.label)
        except Exception:
            # It expires on its own; the next month takes it again.
            log.exception("%s: could not keep the %s through the pause", holder, ls.label)


def release_backfill_hold(mirror: zarrstore.Mirror, host: str, execution: str) -> bool:
    """End backfill execution `execution`'s hold on `host`'s slot, and its reservation, only ever its own. True when a hold was released."""
    _check_backend(mirror)
    if not valid_execution(execution):
        raise ValueError(f"not an execution id: {execution!r}")
    owner, holder = backfill_owner(execution), backfill_holder(execution)
    ls = _Lease(host_slot_key(host), f"{host} request slot", HostBusy, holder=holder, reservation=host_reservation_key(host))
    released = _release(mirror, ls, owner)
    got = _read(mirror, ls.reservation)
    if got is not None and got[0].get("owner") == owner:
        _delete(mirror, ls.reservation)
    if released:
        log.info("%s: released the %s at the end of the backfill", holder, ls.label)
    else:
        log.info("%s: no %s to release (it had expired and gone, or was another's)", holder, ls.label)
    return released
