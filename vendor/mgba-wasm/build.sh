#!/usr/bin/env bash
# pi-extension-gba — vendored mgba-wasm build driver.
#
# Builds the Docker image defined by ./Dockerfile, then copies the
# resulting mgba.js / mgba.wasm / mgba.d.ts out of the image into ./dist/.
#
# Requires: docker. Does NOT require emsdk on the host.
#
# Usage:
#   ./build.sh          # build image (if needed) and copy artefacts to ./dist/
#   ./build.sh --clean  # force a clean rebuild
#
# The resulting ./dist/ is committed into the repository so downstream
# extension consumers never need Emscripten or Docker.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

IMAGE_TAG="pi-extension-gba/mgba-wasm:vendor"
MGBA_SHA="be30a34e913da1ba7f040d3db4e10f700ce49f76"

if [[ "${1:-}" == "--clean" ]]; then
  echo "[build.sh] --clean: removing prior image + dist/"
  docker image rm "${IMAGE_TAG}" 2>/dev/null || true
  rm -rf ./dist
  mkdir -p ./dist
fi

mkdir -p ./dist

echo "[build.sh] building Docker image ${IMAGE_TAG} (mgba sha=${MGBA_SHA})"
docker build \
  --build-arg "MGBA_SHA=${MGBA_SHA}" \
  -t "${IMAGE_TAG}" \
  .

# Spin up a throwaway container and copy out the artefacts. `docker cp`
# from a stopped container is the portable way to extract files without
# writing to a bind-mounted volume (which can have permission quirks on
# macOS / WSL).
echo "[build.sh] extracting artefacts into ./dist/"
CID=$(docker create "${IMAGE_TAG}")
trap 'docker rm -f "${CID}" >/dev/null 2>&1 || true' EXIT

for f in mgba.js mgba.wasm mgba.d.ts mgba.wasm.map; do
  if docker cp "${CID}:/out/${f}" "./dist/${f}" 2>/dev/null; then
    echo "[build.sh]   ${f}: ok ($(wc -c <"./dist/${f}") bytes)"
  else
    echo "[build.sh]   ${f}: MISSING (may be expected for mgba.wasm.map with --flto)"
  fi
done

docker rm -f "${CID}" >/dev/null
trap - EXIT

echo "[build.sh] done. dist contents:"
ls -la ./dist/
