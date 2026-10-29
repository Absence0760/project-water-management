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
FROM public.ecr.aws/lambda/python:3.14-arm64@sha256:3cb99eff2a8eda5b7f7a160d52e42a996ad2236c40e27243778c1c4baea9b3c6

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir --require-hashes -r ${LAMBDA_TASK_ROOT}/requirements.txt

# The job's modules only: no tests, no fixtures (production runs FEED_SOURCE=live).
COPY agera5.py agera5request.py c3s_seasonal.py c3srequest.py cdsjob.py chcnetcdf.py chirps_final.py cloudwatch.py earthdata.py ecmwf.py era5land.py era5request.py fao56.py grid.py imerg.py lambda_handler.py lease.py manifest.py nasapower.py polite.py zarrstore.py ${LAMBDA_TASK_ROOT}/

# Not root (Trivy DS-0002). Lambda runs the image as its own unprivileged
# user anyway; this covers a local `docker run`. 65534 is nobody: numeric, so
# it needs no /etc/passwd entry, and the code and packages above are
# world-readable, the only writes go to /tmp.
USER 65534

CMD ["lambda_handler.handler"]
