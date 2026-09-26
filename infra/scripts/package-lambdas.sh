#!/usr/bin/env bash
# Build and zip the four backend Lambdas, and bundle the fifth (the report
# renderer, a container image). Used by .github/workflows/deploy-backend.yml;
# runnable locally from anywhere in the repo (needs `pnpm install` first).
#
#   infra/scripts/package-lambdas.sh            # → backend/dist/{lambda,migrate,worker,fetcher}.zip
#                                               #   + backend/dist/renderer/lambda-renderer.mjs
#
# Package layouts (they must match the handlers in infra/lambda.tf):
#
#   lambda.zip                        handler lambda.handler
#     lambda.mjs                      esbuild bundle of backend/src/lambda.ts
#     rds-global-bundle.pem           RDS CA bundle (NODE_EXTRA_CA_CERTS)
#
#   migrate.zip                       handler dist/lambda-migrate.handler
#     dist/lambda-migrate.mjs         esbuild bundle of backend/src/lambda-migrate.ts
#     migrations/*.sql                read by scripts/migrate.ts from <dirname>/../migrations
#     rds-global-bundle.pem
#
#   worker.zip                        handler lambda-worker.handler (infra/jobs.tf)
#     lambda-worker.mjs               esbuild bundle of backend/src/lambda-worker.ts
#     rds-global-bundle.pem
#
#   renderer/lambda-renderer.mjs      esbuild bundle of backend/src/lambda-renderer.ts, for the
#                                     image backend/renderer.Dockerfile builds (infra/reports.tf;
#                                     handler lambda-renderer.handler)
#
#   fetcher.zip                       handler lambda-fetcher.handler (infra/feeds.tf)
#     lambda-fetcher.mjs              esbuild bundle of backend/src/lambda-fetcher.ts
#                                     (no database, so no CA bundle)
#
# playwright-core stays OUT of the API, worker and fetcher bundles (--external): only the
# report renderer drives Chromium, and it ships as a container image with
# playwright-core installed beside its bundle (backend/renderer.Dockerfile,
# built by deploy-backend.yml). The API reaches the render code only through
# the test-only memory job transport, and the production worker hands renders
# to that Lambda (REPORT_RENDERER=sqs); the check at the end refuses a bundle
# that pulled it in anyway.
#
# The API, worker and fetcher bundles include @aws-sdk/client-sqs (job wake-ups, feed queues) the
# same way; the API and worker also @aws-sdk/client-s3 + the presigner (report
# download links). The API bundle includes @aws-sdk/client-sesv2 (email), so production sends mail
# with the lockfile's pinned SDK, not whatever the nodejs24.x runtime ships. The
# migrate Lambda keeps @aws-sdk/* external: it imports Secrets Manager from the
# runtime on purpose (see backend/src/lambda-migrate.ts), and it isn't a
# backend dependency.
set -euo pipefail

repo_root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
backend="$repo_root/backend"
ca="$repo_root/infra/certs/rds-global-bundle.pem"
out="$backend/dist"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

[[ -f "$ca" ]] || { echo "error: missing $ca" >&2; exit 1; }
compgen -G "$backend/migrations/*.sql" >/dev/null || { echo "error: no migrations in $backend/migrations" >&2; exit 1; }

# ESM bundles that still contain CommonJS deps (pg) need a real `require`.
banner="import{createRequire}from'module';const require=createRequire(import.meta.url);"
esbuild() {
  pnpm --dir "$backend" exec esbuild "$@" \
    --bundle --platform=node --target=node24 --format=esm \
    --banner:js="$banner" --log-level=warning
}

rm -rf "$out/lambda.zip" "$out/migrate.zip" "$out/worker.zip" "$out/fetcher.zip" "$out/renderer"
mkdir -p "$out" "$stage/api" "$stage/migrate/dist" "$stage/migrate/migrations" "$stage/worker" "$stage/fetcher"

# --- API ---------------------------------------------------------------------
esbuild "$backend/src/lambda.ts" --external:playwright-core --outfile="$stage/api/lambda.mjs"
cp "$ca" "$stage/api/rds-global-bundle.pem"
(cd "$stage/api" && zip -q -9 -X -r "$out/lambda.zip" .)

# --- Migrate -----------------------------------------------------------------
esbuild "$backend/src/lambda-migrate.ts" --external:'@aws-sdk/*' --outfile="$stage/migrate/dist/lambda-migrate.mjs"
cp "$backend"/migrations/*.sql "$stage/migrate/migrations/"
cp "$ca" "$stage/migrate/rds-global-bundle.pem"
(cd "$stage/migrate" && zip -q -9 -X -r "$out/migrate.zip" .)

# --- Worker --------------------------------------------------------------------
esbuild "$backend/src/lambda-worker.ts" --external:playwright-core --outfile="$stage/worker/lambda-worker.mjs"
cp "$ca" "$stage/worker/rds-global-bundle.pem"
(cd "$stage/worker" && zip -q -9 -X -r "$out/worker.zip" .)

# --- Renderer (bundle only) -------------------------------------------------------
# A container image, not a zip: backend/renderer.Dockerfile copies this bundle
# into Playwright's image beside playwright-core (external here).
mkdir -p "$out/renderer"
esbuild "$backend/src/lambda-renderer.ts" --external:playwright-core --outfile="$out/renderer/lambda-renderer.mjs"

# --- Fetcher -------------------------------------------------------------------
esbuild "$backend/src/lambda-fetcher.ts" --external:playwright-core --outfile="$stage/fetcher/lambda-fetcher.mjs"
(cd "$stage/fetcher" && zip -q -9 -X -r "$out/fetcher.zip" .)

# Neither Lambda bundle may carry dotenv: it would read env files from the
# package in production (docs/STACK.md § Two backend entry points).
for f in "$stage/api/lambda.mjs" "$stage/worker/lambda-worker.mjs" "$stage/fetcher/lambda-fetcher.mjs" "$out/renderer/lambda-renderer.mjs"; do
  if grep -q 'dotenv' "$f"; then echo "error: $(basename "$f") bundles dotenv" >&2; exit 1; fi
done

# Nor may they carry Chromium's driver (see above).
for f in "$stage/api/lambda.mjs" "$stage/worker/lambda-worker.mjs" "$stage/fetcher/lambda-fetcher.mjs"; do
  if grep -q 'chromium-bidi' "$f"; then echo "error: $(basename "$f") bundles playwright-core" >&2; exit 1; fi
done

# The fetcher and renderer have no database, so no pg (issue #34; lambda-fetcher.test.ts checks the import graph).
for f in "$stage/fetcher/lambda-fetcher.mjs" "$out/renderer/lambda-renderer.mjs"; do
  if grep -q 'node_modules/pg/' "$f"; then echo "error: $(basename "$f") bundles pg" >&2; exit 1; fi
done

for z in lambda migrate worker fetcher; do
  echo "== $z.zip ($(du -h "$out/$z.zip" | cut -f1))"
  unzip -Z1 "$out/$z.zip" | sed 's/^/   /'
done
