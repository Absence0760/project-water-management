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
#
# Minified, names kept, source maps kept OUT of the packages. Every bundle is
# built with --minify --keep-names --sourcemap: about half the raw size (the
# bulk is zod 4 and the AWS SDK), so less JS to parse on a cold start, while
# stack traces still name the function. The .map files go to
# backend/dist/sourcemaps/ (uploaded beside the zips by deploy-backend.yml),
# not into the zips or the renderer image: a map in the package roughly triples
# the zip, and NODE_OPTIONS=--enable-source-maps makes Node parse it on every
# cold start. To read a production trace, put the map beside the bundle and run
# it under `node --enable-source-maps` (docs/deployment.md § Lambda bundles).
#
# The dependency guards at the end read esbuild's --metafile (the input files
# that went into each bundle, and the external imports left in each output),
# not the bundle text: minifying strips the `// node_modules/...` path comments
# a grep would look for.
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
maps="$out/sourcemaps"
meta="$stage/meta"
# esbuild <name> <entry> <outfile> [flags…]: bundle and minify, then move the
# map out of the package directory into $maps. The metafile lands at $meta/<name>.json.
esbuild() {
  local name=$1 entry=$2 outfile=$3; shift 3
  pnpm --dir "$backend" exec esbuild "$entry" "$@" \
    --bundle --platform=node --target=node24 --format=esm \
    --minify --keep-names --sourcemap \
    --banner:js="$banner" --log-level=warning \
    --metafile="$meta/$name.json" --outfile="$outfile"
  mv "$outfile.map" "$maps/"
}

rm -rf "$out/lambda.zip" "$out/migrate.zip" "$out/worker.zip" "$out/fetcher.zip" "$out/renderer" "$maps"
mkdir -p "$out" "$maps" "$meta" "$stage/api" "$stage/migrate/dist" "$stage/migrate/migrations" "$stage/worker" "$stage/fetcher"

# --- API ---------------------------------------------------------------------
esbuild api "$backend/src/lambda.ts" "$stage/api/lambda.mjs" --external:playwright-core
cp "$ca" "$stage/api/rds-global-bundle.pem"
(cd "$stage/api" && zip -q -9 -X -r "$out/lambda.zip" .)

# --- Migrate -----------------------------------------------------------------
esbuild migrate "$backend/src/lambda-migrate.ts" "$stage/migrate/dist/lambda-migrate.mjs" --external:'@aws-sdk/*'
cp "$backend"/migrations/*.sql "$stage/migrate/migrations/"
cp "$ca" "$stage/migrate/rds-global-bundle.pem"
(cd "$stage/migrate" && zip -q -9 -X -r "$out/migrate.zip" .)

# --- Worker --------------------------------------------------------------------
esbuild worker "$backend/src/lambda-worker.ts" "$stage/worker/lambda-worker.mjs" --external:playwright-core
cp "$ca" "$stage/worker/rds-global-bundle.pem"
(cd "$stage/worker" && zip -q -9 -X -r "$out/worker.zip" .)

# --- Renderer (bundle only) -------------------------------------------------------
# A container image, not a zip: backend/renderer.Dockerfile copies this bundle
# into Playwright's image beside playwright-core (external here).
mkdir -p "$out/renderer"
esbuild renderer "$backend/src/lambda-renderer.ts" "$out/renderer/lambda-renderer.mjs" --external:playwright-core

# --- Fetcher -------------------------------------------------------------------
esbuild fetcher "$backend/src/lambda-fetcher.ts" "$stage/fetcher/lambda-fetcher.mjs" --external:playwright-core
(cd "$stage/fetcher" && zip -q -9 -X -r "$out/fetcher.zip" .)

# guard <bundle> [--forbid|--forbid-static <package> <why>]…: refuse a bundle
# whose metafile shows the package, either bundled (its files are inputs) or
# imported as an external (the import left in the output). --forbid-static
# still allows a lazy `import()` of it. scripts/guards/check_lambda_bundle.mjs
# holds the rules and its node:test suite (pnpm test:guards); it also fails a
# metafile that names no src/lambda*.ts entry, so a reshaped metafile can't
# pass every check.
guard() {
  local name=$1; shift
  node "$repo_root/scripts/guards/check_lambda_bundle.mjs" "$meta/$name.json" "$name" "$@"
}

# No Lambda bundle may carry dotenv: it would read env files from the
# package in production (docs/STACK.md § Two backend entry points). Migrate is
# exempt, as it always was: it bundles backend/scripts/migrate.ts, whose CLI
# branch (never taken in the Lambda) calls dotenv's config().
dotenv=(--forbid dotenv 'docs/STACK.md § Two backend entry points')
# Nor may the API, worker and fetcher carry Chromium's driver (see above).
# playwright-core is --external in all of them, so it is never an input: the
# guard reads the output's imports, and refuses any but the lazy
# `await import('playwright-core')` in src/reports/render.ts, which the API and
# worker reach and which only runs where the package is installed.
chromium=(--forbid-static playwright-core 'only the renderer image ships it' --forbid chromium-bidi 'only the renderer image ships it')
# The fetcher and renderer have no database, so no pg (issue #34; lambda-fetcher.test.ts checks the import graph).
pg=(--forbid pg 'no database')

guard api "${dotenv[@]}" "${chromium[@]}"
guard worker "${dotenv[@]}" "${chromium[@]}"
guard fetcher "${dotenv[@]}" "${chromium[@]}" "${pg[@]}"
guard renderer "${dotenv[@]}" "${pg[@]}"

for z in lambda migrate worker fetcher; do
  echo "== $z.zip ($(du -h "$out/$z.zip" | cut -f1))"
  unzip -Z1 "$out/$z.zip" | sed 's/^/   /'
done
echo "== source maps, not shipped ($maps)"
for m in "$maps"/*; do echo "   $(basename "$m")"; done
