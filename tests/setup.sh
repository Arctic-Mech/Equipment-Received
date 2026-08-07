#!/usr/bin/env bash
# One-time setup for the browser suites.
#
#   ./tests/setup.sh
#
# Installs Playwright and caches the three CDN libraries the app loads at runtime so the suites
# run hermetically and offline. Without the cache the suites still run -- routeCdn() falls through
# to the real CDN -- they just need internet.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> installing test dependencies"
npm install --no-audit --no-fund

echo "==> caching CDN libraries into tests/vendor"
mkdir -p vendor
fetch(){ [ -f "vendor/$2" ] || curl -fsSL --max-time 120 -o "vendor/$2" "$1" && echo "    $2"; }
fetch https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js          jspdf.umd.min.js
fetch https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js            pdf.min.js
fetch https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js     pdf.worker.min.js
fetch https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js            xlsx.full.min.js
fetch https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js         pdf-lib.min.js

echo
echo "Done. Run the suites with:  ./tests/run.sh"
