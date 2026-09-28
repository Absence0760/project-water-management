#!/usr/bin/env bash
# Build the report renderer's container image and smoke-test it the way Lambda
# runs it (infra/scripts/smoke-renderer-image.sh): the release path's
# packaging, the release path's `docker buildx build`, then Chromium, the handler
# under the Lambda runtime interface emulator, and the init check. Same steps
# CI runs (ci.yml, job `renderer-image`). Needs docker and `pnpm install`; no
# AWS account. The image is ~3.5 GB on disk (Playwright's base image).
set -euo pipefail

cd "$(dirname "$0")/.."

command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }

image=water-management-renderer
infra/scripts/package-lambdas.sh
# The release's exact build command (deploy-backend.yml, job `build`): one
# linux/amd64 image manifest, no provenance or SBOM attestations. Lambda
# rejects an image index, which is what attestations turn a push into once
# Docker uses the containerd image store (the default from Engine 29).
docker buildx build --provenance=false --sbom=false --platform linux/amd64 --load \
	-f backend/renderer.Dockerfile -t "$image" backend
infra/scripts/smoke-renderer-image.sh "$image"
