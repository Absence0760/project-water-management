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

FROM mcr.microsoft.com/playwright:v1.63.0-noble AS deps
# aws-lambda-ric compiles a native addon at install.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends g++ make cmake autoconf automake libtool python3 unzip libcurl4-openssl-dev \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /deps
RUN npm install --omit=dev --no-audit --no-fund playwright-core@1.63.0 aws-lambda-ric@4.0.2

FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /var/task
COPY --from=deps /deps/node_modules ./node_modules
COPY dist/renderer/lambda-renderer.mjs ./lambda-renderer.mjs
# Lambda's filesystem is read-only except /tmp; Chromium writes its profile under HOME.
ENV HOME=/tmp \
	NODE_ENV=production \
	PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENTRYPOINT ["node", "/var/task/node_modules/aws-lambda-ric/index.mjs"]
CMD ["lambda-renderer.handler"]
