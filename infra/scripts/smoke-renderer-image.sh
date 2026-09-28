#!/usr/bin/env bash
# Smoke-test the report renderer's container image (backend/renderer.Dockerfile)
# the way Lambda runs it, with no AWS account. CI runs it on every PR
# (ci.yml, renderer-image) and deploy-backend.yml before it ships the image.
#
#   infra/scripts/package-lambdas.sh
#   docker buildx build --provenance=false --sbom=false --platform linux/amd64 --load \
#     -f backend/renderer.Dockerfile -t water-management-renderer backend
#   infra/scripts/smoke-renderer-image.sh [image]      # default: water-management-renderer
#
# Every container runs as Lambda runs one: a uid with no passwd entry, a
# read-only root filesystem, and only /tmp writable.
#
#   1. Chromium prints a PDF inside the image with the renderer's Lambda
#      launch flags (reports/render.ts LAMBDA_ARGS): the image's browser build
#      is the one its playwright-core drives, and it runs under those limits.
#   2. The handler answers through the Lambda runtime interface emulator
#      (aws-lambda-rie, pinned below by version and SHA-256), with a
#      production-shaped env: aws-lambda-ric starts, loads
#      lambda-renderer.handler, and drops a request it can't parse
#      ({"batchItemFailures":[]}, render_request_ignored), without touching
#      S3 or SQS.
#   3. The same image with REPORTS_BUCKET unset refuses to start
#      (config/production.ts assertLambdaEnv), so the init check is live.
#
# A full render through the handler needs the deployed site, API, bucket and
# queues (the production check refuses local URLs); that is checked after the
# first deploy (docs/deployment.md § Reports).
set -euo pipefail

IMAGE="${1:-water-management-renderer}"
RIE_VERSION="v1.37"
RIE_SHA256="6b1e686e62ab2baf5759c412c4864276ef2a88b094fca53ec070637ccba9b9a5"
RIE_BIN="${RIE_BIN:-${XDG_CACHE_HOME:-$HOME/.cache}/water-management/aws-lambda-rie-${RIE_VERSION}}"

# Mirrors reports/render.ts LAMBDA_ARGS.
LAMBDA_ARGS="['--no-sandbox','--no-zygote','--single-process','--disable-dev-shm-usage','--disable-gpu']"
AS_LAMBDA=(--read-only --tmpfs /tmp:rw,exec --user 993:990)
PROD_ENV=(
	-e AWS_REGION=eu-west-1
	-e STORAGE=s3
	-e RENDER_RESULTS_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/000000000000/renderer-smoke
	-e RENDER_SITE_URL=https://renderer-smoke.example.org
	-e RENDER_API_URL=https://renderer-smoke.example.org/api
)

containers=()
cleanup() { for c in "${containers[@]}"; do docker rm -f "$c" > /dev/null 2>&1 || true; done; }
trap cleanup EXIT

fail() {
	echo "::error::renderer image smoke: $1" >&2
	exit 1
}

# --- The emulator: pinned by version and checksum -----------------------------------------
if [ ! -x "$RIE_BIN" ] || ! echo "$RIE_SHA256  $RIE_BIN" | sha256sum -c --status; then
	mkdir -p "$(dirname "$RIE_BIN")"
	curl -sSfL --retry 3 -o "$RIE_BIN.part" \
		"https://github.com/aws/aws-lambda-runtime-interface-emulator/releases/download/${RIE_VERSION}/aws-lambda-rie"
	echo "$RIE_SHA256  $RIE_BIN.part" | sha256sum -c --status || fail "aws-lambda-rie ${RIE_VERSION} does not match its pinned SHA-256"
	chmod +x "$RIE_BIN.part"
	mv "$RIE_BIN.part" "$RIE_BIN"
fi

# --- 1. Chromium prints inside the image ---------------------------------------------------
echo "1/3 Chromium prints a PDF in the image"
docker run --rm "${AS_LAMBDA[@]}" --entrypoint node -w /var/task "$IMAGE" --input-type=module -e "
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ args: ${LAMBDA_ARGS} });
const page = await browser.newPage();
await page.setContent('<h1>renderer image smoke</h1>');
const pdf = await page.pdf({ format: 'A4' });
const version = browser.version();
await browser.close();
if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('the print is not a PDF');
console.log('   Chromium ' + version + ', ' + pdf.length + ' bytes of PDF');
" || fail "Chromium could not print in the image (step 1)"

# Start the image under the emulator; prints the container id.
start_rie() {
	local id
	id=$(docker run -d "${AS_LAMBDA[@]}" -p 127.0.0.1::8080 -v "$RIE_BIN:/rie:ro" --entrypoint /rie \
		-e AWS_LAMBDA_FUNCTION_NAME=renderer-smoke "${PROD_ENV[@]}" "$@" \
		"$IMAGE" node /var/task/node_modules/aws-lambda-ric/index.mjs lambda-renderer.handler)
	containers+=("$id")
	echo "$id"
}

# POST an event to the emulator; prints the response body. Waits for the
# emulator's port to accept (a real signal, not a sleep), then invokes once.
invoke() {
	local id="$1" body="$2" port url
	port=$(docker port "$id" 8080/tcp | head -n1 | sed 's/.*://')
	url="http://127.0.0.1:${port}/2015-03-31/functions/function/invocations"
	for _ in $(seq 1 50); do
		if curl -s -o /dev/null "http://127.0.0.1:${port}/"; then break; fi
		[ "$(docker inspect -f '{{.State.Running}}' "$id")" = "true" ] || fail "the emulator container exited: $(docker logs "$id" 2>&1 | tail -n 20)"
		sleep 0.2
	done
	curl -sS --max-time 60 -XPOST "$url" -d "$body"
}

EVENT='{"Records":[{"messageId":"smoke-1","body":"not a render request"}]}'

# --- 2. The handler answers ----------------------------------------------------------------
echo "2/3 The handler answers under the Lambda runtime emulator"
rie=$(start_rie -e REPORTS_BUCKET=renderer-smoke)
answer=$(invoke "$rie" "$EVENT")
logs=$(docker logs "$rie" 2>&1)
if [ "$answer" != '{"batchItemFailures":[]}' ]; then
	echo "$logs" >&2
	fail "the handler answered '$answer', expected {\"batchItemFailures\":[]} (step 2)"
fi
grep -q '"event":"render_request_ignored","messageId":"smoke-1"' <<< "$logs" || {
	echo "$logs" >&2
	fail "the handler did not log render_request_ignored for the unparseable record (step 2)"
}
echo "   $answer"

# --- 3. The init check refuses a local default ---------------------------------------------
echo "3/3 The renderer refuses to start without REPORTS_BUCKET"
rie=$(start_rie)
answer=$(invoke "$rie" "$EVENT" || true)
logs=$(docker logs "$rie" 2>&1)
grep -q 'refusing to start the renderer Lambda: REPORTS_BUCKET is not set' <<< "$answer$logs" || {
	echo "$answer" >&2
	echo "$logs" >&2
	fail "the renderer started without REPORTS_BUCKET (step 3)"
}
echo "   refused"

echo "renderer image smoke: passed"
