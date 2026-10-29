"""The copy's freshness metric (issue #604 rule 4; infra/ingest.tf's lag alarms).

    namespace  water-management/Mirror   (MIRROR_METRIC_NAMESPACE overrides it)
    metric     MirrorLagDays              (Unit None: whole days)
    dimension  Product = rnl | sat
    value      today (UTC) minus the product's manifest finalThrough, in days

The lag alarms treat a missing datapoint as breaching, so lambda_handler
publishes this on every run that gets as far as knowing its product and its
copy: a 304, a run that copied files, a run the time budget cut short, a run
another writer held off, and a run that failed (published before the error is
re-raised, so the lag stays truthful while the errors alarm says why).

Before any month is copied (`finalThrough` null) the lag counts from the day
before the product's first month (rnl 1981-01, sat 2000-06): the copy holds
nothing, and the alarm should say so.

`CloudWatchSink` publishes through boto3 (live); `LocalSink` keeps the values
in memory and logs them (fixtures mode and tests).
"""

from __future__ import annotations

import datetime as dt
import logging
import os

NAMESPACE = "water-management/Mirror"
METRIC = "MirrorLagDays"

#: The first month CHC publishes byMonth finals for, per product (Round 0).
FIRST_MONTH = {"rnl": (1981, 1), "sat": (2000, 6)}

log = logging.getLogger("ingest")


def lag_days(product: str, final_through: str | None, today: dt.date) -> int:
    """Whole days from finalThrough (or the day before the product's first month) to today."""
    if final_through is None:
        y, m = FIRST_MONTH[product]
        through = dt.date(y, m, 1) - dt.timedelta(days=1)
    else:
        through = dt.date.fromisoformat(final_through)
    return (today - through).days


class CloudWatchSink:
    def __init__(self, client=None, namespace: str | None = None):
        if client is None:
            import boto3

            client = boto3.client("cloudwatch")
        self.client = client
        self.namespace = namespace or os.environ.get("MIRROR_METRIC_NAMESPACE") or NAMESPACE

    def publish(self, product: str, value: int) -> None:
        self.client.put_metric_data(
            Namespace=self.namespace,
            MetricData=[{"MetricName": METRIC, "Dimensions": [{"Name": "Product", "Value": product}], "Value": float(value), "Unit": "None"}],
        )
        log.info("published %s %s{Product=%s} = %s", self.namespace, METRIC, product, value)

    def publish_metric(self, metric: str, product: str, value: int) -> None:
        """Another per-product metric in the same namespace (EarthdataTokenDaysLeft, earthdata.py)."""
        self.client.put_metric_data(
            Namespace=self.namespace,
            MetricData=[{"MetricName": metric, "Dimensions": [{"Name": "Product", "Value": product}], "Value": float(value), "Unit": "None"}],
        )
        log.info("published %s %s{Product=%s} = %s", self.namespace, metric, product, value)


class LocalSink:
    """Fixtures mode: no CloudWatch; the values are kept and logged."""

    def __init__(self):
        self.published: list[tuple[str, int]] = []
        #: Metrics other than MirrorLagDays: (metric, product, value).
        self.other: list[tuple[str, str, int]] = []

    def publish(self, product: str, value: int) -> None:
        self.published.append((product, value))
        log.info("(local) %s{Product=%s} = %s", METRIC, product, value)

    def publish_metric(self, metric: str, product: str, value: int) -> None:
        self.other.append((metric, product, value))
        log.info("(local) %s{Product=%s} = %s", metric, product, value)
