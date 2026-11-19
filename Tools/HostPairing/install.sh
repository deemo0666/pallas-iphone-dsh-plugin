#!/bin/sh
# Installs Pallas iPhone Control into this computer's DSH web profile.
# DSH_HOME picks the DSH home (default ~/.dsh). Restart `dsh web` afterwards.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
command -v dsh >/dev/null || { echo "error: dsh is required" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "error: pnpm is required (npm install -g pnpm)" >&2; exit 1; }
home=${DSH_HOME:-$HOME/.dsh}
mkdir -p "$home"
DSH_HOME=$(cd "$home" && pwd)
export DSH_HOME

cd "$here"
# The mesh node (Tools/PallasMesh/node), so a paired phone can reach this computer from anywhere.
if [ -f ../PallasMesh/go.mod ] && command -v go >/dev/null; then
  (cd ../PallasMesh && go build -trimpath -ldflags="-s -w" -o "$here/bin/pallas-mesh-node" ./node)
fi
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
package=$(npm pack --silent --pack-destination "$DSH_HOME")
dsh plugin --profile web add "$DSH_HOME/$package"
echo "Pallas iPhone Control installed. Restart dsh web and open Pallas iPhone Control in the sidebar."
