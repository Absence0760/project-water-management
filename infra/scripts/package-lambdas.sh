#!/usr/bin/env bash
# Build and zip both backend Lambdas. Used by .github/workflows/deploy-backend.yml;
# runnable locally from anywhere in the repo (needs `pnpm install` first).
#
#   infra/scripts/package-lambdas.sh            # → backend/dist/lambda.zip, backend/dist/migrate.zip
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
# @aws-sdk/* stays external: the nodejs24.x runtime provides it. The migrate
# Lambda uses it for Secrets Manager and the API Lambda for SES v2 (email), so
# in production both run the runtime's SDK version, not the lockfile's.
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
    --external:'@aws-sdk/*' --banner:js="$banner" --log-level=warning
}

rm -f "$out/lambda.zip" "$out/migrate.zip"
mkdir -p "$out" "$stage/api" "$stage/migrate/dist" "$stage/migrate/migrations"

# --- API ---------------------------------------------------------------------
esbuild "$backend/src/lambda.ts" --outfile="$stage/api/lambda.mjs"
cp "$ca" "$stage/api/rds-global-bundle.pem"
(cd "$stage/api" && zip -q -9 -X -r "$out/lambda.zip" .)

# --- Migrate -----------------------------------------------------------------
esbuild "$backend/src/lambda-migrate.ts" --outfile="$stage/migrate/dist/lambda-migrate.mjs"
cp "$backend"/migrations/*.sql "$stage/migrate/migrations/"
cp "$ca" "$stage/migrate/rds-global-bundle.pem"
(cd "$stage/migrate" && zip -q -9 -X -r "$out/migrate.zip" .)

for z in lambda migrate; do
  echo "== $z.zip ($(du -h "$out/$z.zip" | cut -f1))"
  unzip -Z1 "$out/$z.zip" | sed 's/^/   /'
done
