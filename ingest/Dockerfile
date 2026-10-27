# The bulk ingest Lambda's container image (issue #604 D11; ingest/README.md).
#
#   docker buildx build --platform linux/arm64 -f ingest/Dockerfile ingest
#
# Build context is ingest/, arm64 only. The handler is lambda_handler.handler.
#
# The base is AWS's Lambda Python 3.14 image, the arm64 tag pinned by digest
# (`pnpm check:pins` refuses a FROM without one, and a pip install without
# --require-hashes). Moving it: look the digest up, never guess it,
#   docker buildx imagetools inspect public.ecr.aws/lambda/python:3.14-arm64
# and put the tag and the new digest here together. Dependabot's docker entry
# for /ingest (.github/dependabot.yml) proposes the same move.
FROM public.ecr.aws/lambda/python:3.14-arm64@sha256:9b353a9c5d361d322f58ce176f1322deb983ecd8da367a52256a20e1ccc7ad06

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir --require-hashes -r ${LAMBDA_TASK_ROOT}/requirements.txt

# The job's modules only: no tests, no fixtures (production runs FEED_SOURCE=live).
COPY chcnetcdf.py chirps_final.py era5land.py cloudwatch.py grid.py lambda_handler.py lease.py manifest.py polite.py zarrstore.py ${LAMBDA_TASK_ROOT}/

CMD ["lambda_handler.handler"]
