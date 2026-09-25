#!/usr/bin/env bash
# Build and zip the three backend Lambdas. Used by .github/workflows/deploy-backend.yml;
# runnable locally from anywhere in the repo (needs `pnpm install` first).
#
#   infra/scripts/package-lambdas.sh            # → backend/dist/{lambda,migrate,worker}.zip
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
# The API and worker bundles include @aws-sdk/client-sqs (job wake-ups) the
# same way. The API bundle includes @aws-sdk/client-sesv2 (email), so production sends mail
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

rm -f "$out/lambda.zip" "$out/migrate.zip" "$out/worker.zip"
mkdir -p "$out" "$stage/api" "$stage/migrate/dist" "$stage/migrate/migrations" "$stage/worker"

# --- API ---------------------------------------------------------------------
esbuild "$backend/src/lambda.ts" --outfile="$stage/api/lambda.mjs"
cp "$ca" "$stage/api/rds-global-bundle.pem"
(cd "$stage/api" && zip -q -9 -X -r "$out/lambda.zip" .)

# --- Migrate -----------------------------------------------------------------
esbuild "$backend/src/lambda-migrate.ts" --external:'@aws-sdk/*' --outfile="$stage/migrate/dist/lambda-migrate.mjs"
cp "$backend"/migrations/*.sql "$stage/migrate/migrations/"
cp "$ca" "$stage/migrate/rds-global-bundle.pem"
(cd "$stage/migrate" && zip -q -9 -X -r "$out/migrate.zip" .)

# --- Worker --------------------------------------------------------------------
esbuild "$backend/src/lambda-worker.ts" --outfile="$stage/worker/lambda-worker.mjs"
cp "$ca" "$stage/worker/rds-global-bundle.pem"
(cd "$stage/worker" && zip -q -9 -X -r "$out/worker.zip" .)

# Neither Lambda bundle may carry dotenv: it would read env files from the
# package in production (docs/STACK.md § Two backend entry points).
for f in "$stage/api/lambda.mjs" "$stage/worker/lambda-worker.mjs"; do
  if grep -q 'dotenv' "$f"; then echo "error: $(basename "$f") bundles dotenv" >&2; exit 1; fi
done

for z in lambda migrate worker; do
  echo "== $z.zip ($(du -h "$out/$z.zip" | cut -f1))"
  unzip -Z1 "$out/$z.zip" | sed 's/^/   /'
done
