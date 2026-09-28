#!/usr/bin/env bash
# Local equivalent of ci.yml's `workflow-lint` job: this repo's workflow guard
# (SHA pins, OIDC-only, environment gating, CI-gate fan-in), then actionlint
# with the same flags CI uses. actionlint is not a repo dependency; install it
# with `brew install actionlint` or `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12`.
# Without it this still runs the guard and says plainly that actionlint was
# skipped; CI always runs it.
set -euo pipefail

cd "$(dirname "$0")/.."

node scripts/guards/check_workflows.mjs

actionlint_bin=""
if command -v actionlint >/dev/null 2>&1; then
	actionlint_bin="$(command -v actionlint)"
elif command -v go >/dev/null 2>&1 && [ -x "$(go env GOPATH)/bin/actionlint" ]; then
	actionlint_bin="$(go env GOPATH)/bin/actionlint"
fi

if [ -z "$actionlint_bin" ]; then
	echo "actionlint not installed: SKIPPED here (CI runs it). brew install actionlint" >&2
	exit 0
fi
"$actionlint_bin" -shellcheck= -pyflakes=
echo "actionlint OK ($("$actionlint_bin" -version | head -1))."
