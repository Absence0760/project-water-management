#!/usr/bin/env bash
# Local equivalent of ci.yml's `workflow-lint` job: this repo's workflow guard
# (SHA pins, OIDC-only, environment gating, CI-gate fan-in), then actionlint
# with the same flags CI uses. actionlint is not a repo dependency; install
# the version ci.yml pins (`go install github.com/rhysd/actionlint/cmd/actionlint@<pin>`,
# the pin printed below). Without it this still runs the guard and says plainly
# that actionlint was skipped; CI always runs it. A local actionlint other than
# CI's pin is named before it runs: an older one fails on what CI accepts (v1.7.1
# didn't know the ubuntu-24.04-arm runner label, 2026-10-30), so its errors are
# the version's, not the workflow's.
set -euo pipefail

cd "$(dirname "$0")/.."

node scripts/guards/check_workflows.mjs

actionlint_bin=""
if command -v actionlint >/dev/null 2>&1; then
	actionlint_bin="$(command -v actionlint)"
elif command -v go >/dev/null 2>&1 && [ -x "$(go env GOPATH)/bin/actionlint" ]; then
	actionlint_bin="$(go env GOPATH)/bin/actionlint"
fi

# CI's pin, from ci.yml's install step (`…/cmd/actionlint@vX.Y.Z`).
ci_pin="$(grep -oE 'rhysd/actionlint/cmd/actionlint@v[0-9]+\.[0-9]+\.[0-9]+' .github/workflows/ci.yml | head -1 | sed 's/.*@//')"
install_hint="go install github.com/rhysd/actionlint/cmd/actionlint@${ci_pin:-<the pin in ci.yml>}"

if [ -z "$actionlint_bin" ]; then
	echo "actionlint not installed: SKIPPED here (CI runs it). $install_hint" >&2
	exit 0
fi
local_version="$("$actionlint_bin" -version | head -1)"
if [ -n "$ci_pin" ] && [ "$local_version" != "$ci_pin" ]; then
	echo "Note: local actionlint is $local_version, CI pins $ci_pin; an error below may be the version's, not the workflow's. $install_hint" >&2
fi
"$actionlint_bin" -shellcheck= -pyflakes=
echo "actionlint OK ($local_version)."
