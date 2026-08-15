#!/usr/bin/env bash
set -euo pipefail

PACKAGE_VERSION="${MARROW_INSTALL_SMOKE_VERSION:-latest}"
BASE_URL="${MARROW_BASE_URL:-https://api.getmarrow.ai}"
API_KEY="${MARROW_SIGNUP_SMOKE_KEY:-${MARROW_API_KEY:-${MARROW_KEY:-}}}"
AGENT_ID="${MARROW_FLEET_AGENT_ID:-${MARROW_AGENT_ID:-fresh-install-smoke}}"

if [[ -z "${API_KEY}" ]]; then
  echo "SKIP fresh_install_smoke: MARROW_SIGNUP_SMOKE_KEY, MARROW_API_KEY, or MARROW_KEY is required"
  exit 0
fi

workdir="$(mktemp -d "${TMPDIR:-/tmp}/marrow-fresh-install-smoke.XXXXXX")"
cleanup() {
  rm -rf "${workdir}"
}
trap cleanup EXIT

mkdir -p "${workdir}/.marrow"
chmod 700 "${workdir}/.marrow"
printf 'MARROW_API_KEY=%s\nMARROW_BASE_URL=%s\nMARROW_FLEET_AGENT_ID=%s\n' "${API_KEY}" "${BASE_URL}" "${AGENT_ID}" > "${workdir}/.marrow/env"
chmod 600 "${workdir}/.marrow/env"
printf '{"name":"marrow-fresh-install-smoke","private":true}\n' > "${workdir}/package.json"

echo "RUN fresh_install_smoke: @getmarrow/install@${PACKAGE_VERSION}"
if [[ "${PACKAGE_VERSION}" == "local" ]]; then
  node "$(dirname "$0")/../bin/marrow-install.js" --cwd "${workdir}" doctor --self-test --json > "${workdir}/doctor.out"
else
  (cd "${workdir}" && npx -y -p "@getmarrow/install@${PACKAGE_VERSION}" marrow-install --cwd "${workdir}" doctor --self-test --json) > "${workdir}/doctor.out"
fi

jq -e '
  .doctor.active == true
  and .selfTest.active == true
  and .selfTest.runtime_active == true
  and (.selfTest.decision_id | type == "string" and length > 0)
  and .selfTest.first_value.active == true
  and .selfTest.client_update.version_status == "current"
' "${workdir}/doctor.out" >/dev/null

echo "PASS fresh_install_smoke"
