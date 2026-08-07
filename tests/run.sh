#!/usr/bin/env bash
# Run every browser suite and report one line each.
#
#   ./tests/run.sh              all suites
#   ./tests/run.sh ptp growth   only those
#
# Exits non-zero if any suite fails, so it can gate a deploy.
set -uo pipefail
cd "$(dirname "$0")"

ALL=(ui badge_tut myjobs mobile_myjobs lastseen ptp baddata growth monkey)
SUITES=("${@:-}"); [ -z "${SUITES[0]:-}" ] && SUITES=("${ALL[@]}")

echo "==> lint + the format.js <-> email_import.py contract"
( cd .. && npx --yes eslint ./*.js ) || { echo "FAIL  eslint"; exit 1; }
( cd .. && python3 contract_check.py ) || { echo "FAIL  contract_check"; exit 1; }

fail=0
for s in "${SUITES[@]}"; do
  printf '%-18s ' "$s"
  out=$(timeout 600 node "$s.mjs" 2>&1)
  if [ $? -eq 0 ]; then echo "PASS"
  else
    fail=1; echo "FAIL"
    echo "$out" | tail -25 | sed 's/^/    /'
  fi
done
[ $fail -eq 0 ] && echo "==> all suites passed" || echo "==> SOME SUITES FAILED"
exit $fail
