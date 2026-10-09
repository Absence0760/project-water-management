# The renderer Lambda's container image (src/lambda-renderer.ts; infra/reports.tf,
# docs/deployment.md § Reports). Built by .github/workflows/deploy-backend.yml
# from the bundle infra/scripts/package-lambdas.sh writes:
#
#   infra/scripts/package-lambdas.sh
#   docker buildx build --provenance=false --sbom=false --platform linux/amd64 --load \
#     -f backend/renderer.Dockerfile -t water-management-renderer backend
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
# `npm ci` installs exactly, integrity hashes checked, and the deps stage's
# apt packages by exact version from one Ubuntu archive snapshot (below).
# Dependabot's docker entry (.github/dependabot.yml, never auto-merged) opens
# the tag-and-digest PR; on that PR, also run `pnpm gen:renderer-apt` (below).
# To move Playwright:
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
# .tar.xz sources, hence xz-utils. These build tools live in this stage only:
# the final image copies node_modules and nothing else from it.
#
# Pinned like the rest: each package at an exact version, resolved from one
# Ubuntu archive snapshot (snapshot.ubuntu.com, `--snapshot`), so the
# versions stay installable after noble-updates/-security supersede them and
# the unpinned transitive packages are fixed by the same snapshot. The
# versions are the snapshot's candidates, read from the digest-pinned base
# (`apt-cache --snapshot <ID> policy`: a bare `apt-cache policy` reads the live
# lists `apt-get update --snapshot` also fetches, so it reports today's
# versions, not the snapshot's).
#
# Nothing moves the snapshot by itself (Dependabot can't), and until it moves
# these packages get no Ubuntu security update. Move it, and the versions with
# it, with `pnpm gen:renderer-apt` (scripts/guards/renderer_apt_snapshot.mjs:
# APT_SNAPSHOT to today, each version to its candidate there, read in the
# FROM image by docker run), then `pnpm check:pins` (refuses an unpinned
# package) and `pnpm check:renderer-image`:
#   - whenever the base digest moves: on Dependabot's docker PR, in the same PR;
#   - when .github/workflows/renderer-apt-snapshot.yml opens its issue (weekly
#     check; the snapshot is over 90 days old);
#   - for a security fix in one of them.
# Where the packages come from. The snapshot decides every version; the live
# archive is only a second place to download the same files from.
#   - Ubuntu's `main` component only, and no third-party list: every package
#     below and each of its dependencies is in main (checked with
#     `apt-get install -s` against the snapshot). That is a smaller set of indexes
#     than every component's ~64 MB.
#   - snapshot.ubuntu.com is slow (~100-230 kB/s) and answers 500/503 now and
#     then. The 2026-09-29 CI run failed on an index and a local build on a
#     .deb, each after apt's retries. So archive.ubuntu.com is listed too,
#     with `Snapshot: disable` and pinned to priority 100. Every candidate
#     stays the snapshot's (500), but a pinned version the live archive still
#     carries is the same file there, so apt fetches it from whichever source
#     answers. Checked with snapshot.ubuntu.com blocked after `apt-get
#     update`: all 63 packages came from the archive. Both indexes are signed
#     by Ubuntu's archive key, and a version is one file wherever it's served.
#     A version the live archive has dropped comes from the snapshot alone.
# The final stage keeps the base image's sources (it copies only node_modules
# from here).
RUN sed -i 's/^Components: .*/Components: main/' /etc/apt/sources.list.d/ubuntu.sources \
	&& rm -f /etc/apt/sources.list.d/nodesource.list \
	&& printf '%s\n' 'Types: deb' 'URIs: http://archive.ubuntu.com/ubuntu/' 'Suites: noble noble-updates noble-security' 'Components: main' 'Snapshot: disable' 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' > /etc/apt/sources.list.d/ubuntu-live.sources \
	&& printf '%s\n' 'Package: *' 'Pin: origin "archive.ubuntu.com"' 'Pin-Priority: 100' > /etc/apt/preferences.d/80-live-archive-fallback
ARG APT_SNAPSHOT=20260928T000000Z
RUN apt-get update --snapshot "$APT_SNAPSHOT" \
	&& apt-get install -y --no-install-recommends --snapshot "$APT_SNAPSHOT" \
		g++=4:13.2.0-7ubuntu1 \
		make=4.3-4.1build2 \
		cmake=3.28.3-1build7 \
		autoconf=2.71-3 \
		automake=1:1.16.5-1.3ubuntu1 \
		libtool=2.4.7-7build1 \
		python3=3.12.3-0ubuntu2.1 \
		unzip=6.0-28ubuntu4.1 \
		xz-utils=5.6.1+really5.4.5-1ubuntu0.3 \
		libcurl4-openssl-dev=8.5.0-2ubuntu10.15 \
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
# Not root (Trivy DS-0002): the Playwright image's own user. Lambda runs the
# image as its own unprivileged user anyway; this covers a local `docker run`.
USER pwuser
ENTRYPOINT ["node", "/var/task/node_modules/aws-lambda-ric/index.mjs"]
CMD ["lambda-renderer.handler"]
