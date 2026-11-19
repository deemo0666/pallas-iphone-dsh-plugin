#!/bin/bash
# Create a DSH plugin archive from the macOS Runner kit.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
installer=${1:?Usage: package-mac.sh runner-kit.zip output-directory}
output=$(cd "${2:?Provide an output directory}" && pwd)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

ditto -x -k "$installer" "$stage/installer"
resources="$stage/installer/Pallas-Runner"
codesign --verify --strict "$resources/dsh-installer-service"
package="$stage/package"
mkdir -p "$package/mac/Kit" "$package/bin"
cp "$here/"*.js "$here/package.json" "$here/package-lock.json" "$here/cordis.patch.yml" \
    "$here/../../LICENSE.md" "$package/"
cp "$resources/dsh-installer-service" "$resources/metadata.json" "$resources/LICENSE.md" \
    "$resources/ThirdPartyNotices.txt" "$resources/InstallerServiceSource.zip" \
    "$resources/DependencyVersions.lock" "$package/mac/"
# The installer statically links an LGPL library: its source must travel with the binary.
unzip -l "$package/mac/InstallerServiceSource.zip" | grep -q 'lgpl-source/' \
    || { echo 'InstallerServiceSource.zip is missing the LGPL source.' >&2; exit 1; }
cp "$resources/Kit/ScreenRunner.ipa" "$resources/Kit/RunnerHost.json" \
    "$resources/Kit/SHA256SUMS" "$package/mac/Kit/"
(cd "$package/mac/Kit" && shasum -a 256 -c SHA256SUMS)
if [[ -x "$here/bin/pallas-mesh-node" ]]; then
    cp "$here/bin/pallas-mesh-node" "$package/bin/"
    python3 "$here/../PallasMesh/notices.py" "$package/bin/ThirdPartyNotices.txt"
fi

cd "$package"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
archive=$(npm pack --silent --pack-destination "$stage")
target="$output/${archive%.tgz}-macos.tgz"
mv "$stage/$archive" "$target"
echo "$target"
