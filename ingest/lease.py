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


class MirrorBusy(Exception):
    """Another run holds this product's lease."""


def lease_key(product: str) -> str:
    return f"ingest-state/{product}/lease.json"


def _body(owner: str, now: float) -> bytes:
    return (json.dumps({"owner": owner, "expires": now + LEASE_SECONDS}) + "\n").encode()


def _error_code(e: Exception) -> str | None:
    return getattr(e, "response", {}).get("Error", {}).get("Code")


_CONFLICT = {"PreconditionFailed", "ConditionalRequestConflict"}


def _acquire_s3(m: zarrstore.S3Mirror, product: str, owner: str, now: float) -> None:
    key = m._key(lease_key(product))
    try:
        m.client.put_object(Bucket=m.bucket, Key=key, Body=_body(owner, now), IfNoneMatch="*", ContentType="application/json")
        return
    except Exception as e:
        if _error_code(e) not in _CONFLICT:
            raise
    try:
        got = m.client.get_object(Bucket=m.bucket, Key=key)
    except m.client.exceptions.NoSuchKey:
        # Released between our put and this read: try once more from the start.
        try:
            m.client.put_object(Bucket=m.bucket, Key=key, Body=_body(owner, now), IfNoneMatch="*", ContentType="application/json")
            return
        except Exception as e:
            if _error_code(e) in _CONFLICT:
                raise MirrorBusy(f"another run took the {product} lease") from None
            raise
    held = json.loads(got["Body"].read())
    if held.get("expires", 0) > now:
        raise MirrorBusy(f"another run ({held.get('owner')}) holds the {product} lease until {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(held['expires']))}")
    try:
        m.client.put_object(Bucket=m.bucket, Key=key, Body=_body(owner, now), IfMatch=got["ETag"], ContentType="application/json")
    except Exception as e:
        if _error_code(e) in _CONFLICT:
            raise MirrorBusy(f"another run took over the expired {product} lease first") from None
        raise


def _release_s3(m: zarrstore.S3Mirror, product: str, owner: str) -> None:
    key = m._key(lease_key(product))
    try:
        held = json.loads(m.client.get_object(Bucket=m.bucket, Key=key)["Body"].read())
    except m.client.exceptions.NoSuchKey:
        return
    # Ours unless it expired and was taken over, which a Lambda can't outlive.
    if held.get("owner") == owner:
        m.client.delete_object(Bucket=m.bucket, Key=key)


def _acquire_local(m: zarrstore.LocalMirror, product: str, owner: str, now: float) -> None:
    path = m.root / lease_key(product)
    path.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)  # owner only: nothing else on the machine reads it
        except FileExistsError:
            held = json.loads(path.read_text() or "{}")
            if held.get("expires", 0) > now:
                raise MirrorBusy(f"another run ({held.get('owner')}) holds the {product} lease") from None
            path.unlink(missing_ok=True)
            continue
        with os.fdopen(fd, "wb") as f:
            f.write(_body(owner, now))
        return
    raise MirrorBusy(f"another run took the {product} lease")


def _release_local(m: zarrstore.LocalMirror, product: str, owner: str) -> None:
    path = m.root / lease_key(product)
    try:
        held = json.loads(path.read_text())
    except FileNotFoundError:
        return
    if held.get("owner") == owner:
        path.unlink(missing_ok=True)


@contextlib.contextmanager
def hold(mirror: zarrstore.Mirror, product: str, now: Callable[[], float] = time.time):
    """Hold `product`'s lease for the block; raise MirrorBusy if another run has it."""
    owner = uuid.uuid4().hex
    if isinstance(mirror, zarrstore.S3Mirror):
        acquire, release = _acquire_s3, _release_s3
    elif isinstance(mirror, zarrstore.LocalMirror):
        acquire, release = _acquire_local, _release_local
    else:
        raise TypeError(f"no lease for {type(mirror).__name__}")
    acquire(mirror, product, owner, now())
    try:
        yield owner
    finally:
        release(mirror, product, owner)
