#!/usr/bin/env sh
# Runs the browser test suites against a running `docker compose up` stack.
#
#   docker compose up --build -d
#   ./tests/run.sh
#
# Everything runs inside the official Playwright image, so the only host
# requirement is Docker. Screenshots are written to tests/out/.
set -eu

IMAGE="mcr.microsoft.com/playwright:v1.56.0-noble"
PW_VERSION="1.56.0"          # must match the image tag
NETWORK="${NETWORK:-chess-ai_default}"
BASE="${BASE:-http://chess}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MODULES="$HERE/.node_modules"

mkdir -p "$HERE/out" "$MODULES"

if [ ! -d "$MODULES/playwright" ]; then
  echo "> installing the playwright client library (one time)"
  docker run --rm -v "$MODULES:/m" "$IMAGE" sh -c "
    mkdir -p /tmp/pw && cd /tmp/pw &&
    npm init -y >/dev/null 2>&1 &&
    npm install --silent --no-package-lock playwright@$PW_VERSION &&
    cp -a node_modules/. /m/"
fi

status=0
for suite in logic integration; do
  echo ""
  echo "======== $suite ========"
  docker run --rm --network "$NETWORK" \
    -v "$HERE:/work/tests:ro" \
    -v "$MODULES:/work/node_modules:ro" \
    -v "$HERE/out:/work/out" \
    -w /work -e "BASE=$BASE" -e OUT=/work/out \
    "$IMAGE" node "tests/$suite.js" || status=1
done

exit "$status"
