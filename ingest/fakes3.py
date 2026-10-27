"""An in-memory stand-in for the few boto3 S3 client calls zarrstore.S3Mirror
and lease.py make (tests only): ETags, and S3's conditional writes
(IfNoneMatch="*", IfMatch=<etag>) answering 412 PreconditionFailed as a
botocore ClientError, as S3 does."""

import hashlib

from botocore.exceptions import ClientError


class _NoSuchKey(Exception):
    pass


class _Exceptions:
    NoSuchKey = _NoSuchKey


class _Body:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data


class FakeS3:
    exceptions = _Exceptions

    def __init__(self):
        self.objects: dict[tuple[str, str], bytes] = {}
        self.calls: list[tuple[str, str]] = []

    def get_object(self, Bucket, Key):
        self.calls.append(("get", Key))
        if (Bucket, Key) not in self.objects:
            raise _NoSuchKey(Key)
        data = self.objects[(Bucket, Key)]
        return {"Body": _Body(data), "ETag": self.etag(data)}

    @staticmethod
    def etag(data: bytes) -> str:
        return f'"{hashlib.md5(data).hexdigest()}"'

    def put_object(self, Bucket, Key, Body, IfNoneMatch=None, IfMatch=None, **_):
        self.calls.append(("put", Key))
        held = self.objects.get((Bucket, Key))
        if (IfNoneMatch == "*" and held is not None) or (IfMatch is not None and (held is None or self.etag(held) != IfMatch)):
            raise ClientError({"Error": {"Code": "PreconditionFailed", "Message": "At least one of the pre-conditions you specified did not hold"}}, "PutObject")
        self.objects[(Bucket, Key)] = bytes(Body)
        return {"ETag": self.etag(bytes(Body))}

    def delete_object(self, Bucket, Key):
        self.calls.append(("delete", Key))
        self.objects.pop((Bucket, Key), None)

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        fake = self

        class _Paginator:
            def paginate(self, Bucket, Prefix):
                keys = sorted(k for b, k in fake.objects if b == Bucket and k.startswith(Prefix))
                yield {"Contents": [{"Key": k} for k in keys]} if keys else {}

        return _Paginator()

    def keys(self, bucket):
        return sorted(k for b, k in self.objects if b == bucket)
