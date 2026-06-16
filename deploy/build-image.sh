#!/usr/bin/env bash
# Build the forked Ghost "full" production image locally, mirroring the CI pipeline
# (.github/workflows/ci.yml). Run from anywhere; resolves the repo root itself.
#
# Requires: Node 22, pnpm (via corepack), Docker, and git submodules access.
# Usage:   IMAGE=townbrief-ghost:local deploy/build-image.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE="${IMAGE:-townbrief-ghost:local}"
NODE_VERSION="${NODE_VERSION:-22.18.0}"

echo "==> Initializing theme submodules (casper, source)"
git submodule update --init \
  ghost/core/content/themes/casper \
  ghost/core/content/themes/source

echo "==> Installing dependencies (pnpm)"
corepack enable
pnpm install --frozen-lockfile

echo "==> Building server + admin assets (build:production)"
PKG_VERSION="$(node -p "require('./ghost/core/package.json').version")"
SHORT_SHA="$(git rev-parse --short HEAD)"
export GHOST_BUILD_VERSION="${PKG_VERSION}+${SHORT_SHA}"
pnpm build:production

echo "==> Packing standalone distribution (npm pack + extract -> ghost/core/package/)"
pnpm --filter ghost archive

echo "==> Building Docker image: ${IMAGE} (target: full)"
docker build \
  -f Dockerfile.production \
  --target full \
  --build-arg "NODE_VERSION=${NODE_VERSION}" \
  --build-arg "GHOST_BUILD_VERSION=${GHOST_BUILD_VERSION}" \
  -t "${IMAGE}" \
  ghost/core/package

echo "==> Done: ${IMAGE}"
