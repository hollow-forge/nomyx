#!/usr/bin/env bash
#
# Build and push the Nomyx server image to Docker Hub.
#
#   Usage:  ./publish.sh <version>
#   e.g.    ./publish.sh 0.1.0
#
# Requires: DOCKERHUB_USER set, and `docker login` already done with a
# Read & Write access token. Run from the repo root (where the Dockerfile is),
# ideally on the WSL2 native filesystem.

set -euo pipefail

if [[ -z "${DOCKERHUB_USER:-}" ]]; then
  echo "ERROR: set DOCKERHUB_USER first, e.g.  export DOCKERHUB_USER=yourusername" >&2
  exit 1
fi

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "ERROR: version required.  Usage: ./publish.sh <version>   e.g. ./publish.sh 0.1.0" >&2
  exit 1
fi

if [[ ! -f Dockerfile ]]; then
  echo "ERROR: no Dockerfile in $(pwd) — run this from the repo root." >&2
  exit 1
fi

IMAGE="$DOCKERHUB_USER/nomyx"

echo ">> Building $IMAGE:$VERSION (and :latest) for linux/amd64 ..."
docker build \
  --platform linux/amd64 \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  .

echo ">> Pushing $IMAGE:$VERSION ..."
docker push "$IMAGE:$VERSION"

echo ">> Pushing $IMAGE:latest ..."
docker push "$IMAGE:latest"

echo ">> Done. Published:"
echo "     $IMAGE:$VERSION"
echo "     $IMAGE:latest"
