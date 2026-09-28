# The renderer Lambda's container image (src/lambda-renderer.ts; infra/reports.tf,
# docs/deployment.md § Reports). Built by .github/workflows/deploy-backend.yml
# from the bundle infra/scripts/package-lambdas.sh writes:
#
#   infra/scripts/package-lambdas.sh
#   docker build -f backend/renderer.Dockerfile -t water-management-renderer backend
#
# Playwright's own image carries the Chromium build and the system libraries
# that playwright-core drives: the same browser build e2e and the local worker
# use, so a server-side PDF matches the one printed in e2e. The AWS Lambda
# runtime interface client (aws-lambda-ric) turns it into a Lambda.
#
# Pins: the Playwright image tag and playwright-core MUST equal
# backend/package.json's playwright-core (and e2e's @playwright/test), or the
# browser build differs from the one the driver expects.
#
# Everything is pinned by content, not by name (OpenSSF Scorecard,
# Pinned-Dependencies): the image by its digest (the multi-arch index of the
# tag; `docker buildx imagetools inspect mcr.microsoft.com/playwright:<tag>`
# prints it), and the npm packages by renderer-deps/package-lock.json, which
# `npm ci` installs exactly, integrity hashes checked. To move Playwright:
# bump the tag and digest here (both FROM lines), playwright-core in
# renderer-deps/package.json and backend/package.json, then refresh the lock
# with `npm install --package-lock-only` in renderer-deps/. `pnpm check:pins`
# (scripts/guards/check_playwright_pins.mjs) fails until every pin agrees;
# a digest left on the old version fails `pnpm check:renderer-image`
# (infra/scripts/smoke-renderer-image.sh) whenever the new version brings a
# new Chromium build, which the image then lacks. CI runs both on every PR.

FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS deps
# aws-lambda-ric compiles a native addon at install (its preinstall and
# install scripts: the ones renderer-deps/package.json's allowScripts lets
# run, since npm 11.16+ skips every other package's); its preinstall unpacks
# .tar.xz sources, hence xz-utils.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends g++ make cmake autoconf automake libtool python3 unzip xz-utils libcurl4-openssl-dev \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /deps
COPY renderer-deps/package.json renderer-deps/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
WORKDIR /var/task
COPY --from=deps /deps/node_modules ./node_modules
COPY dist/renderer/lambda-renderer.mjs ./lambda-renderer.mjs
# Lambda's filesystem is read-only except /tmp; Chromium writes its profile under HOME.
# aws-lambda-ric 4 loads the handler from LAMBDA_TASK_ROOT and refuses to start
# without it; the runtime sets only _HANDLER (from CMD), and AWS's own base
# images set LAMBDA_TASK_ROOT in the image, so this one does too
# (infra/scripts/smoke-renderer-image.sh caught it).
ENV LAMBDA_TASK_ROOT=/var/task \
	HOME=/tmp \
	NODE_ENV=production \
	PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENTRYPOINT ["node", "/var/task/node_modules/aws-lambda-ric/index.mjs"]
CMD ["lambda-renderer.handler"]
