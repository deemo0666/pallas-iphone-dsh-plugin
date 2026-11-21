# Pallas iPhone Control · DSH Plugin

English · [简体中文](README.zh-CN.md)

Pair with, and install the control component on, an iPhone that already has [Pallas Agent](https://github.com/deemo0666/pallas-agent), right from DSH Web. Once paired, a DSH chat can read the iPhone's screen, tap and open apps.

[Download the macOS plugin v0.3.4 (ZIP)](https://github.com/deemo0666/pallas-iphone-dsh-plugin/releases/download/v0.3.4/dsh-local-pair-0.3.4-macos.zip)

## Install into DSH

Requires a configured DSH Web and macOS 13 or later. The iPhone package inside the plugin is Runner `1.1 (2)`. The iPhone needs Pallas Agent `0.5.1` or later with the **Allow Computer Control** entry. A Pallas Agent sideloaded with the original account must be `0.5.1 (18)` or later with the original installer's shared entitlements.

```sh
unzip dsh-local-pair-0.3.4-macos.zip -d pallas-dsh-0.3.4
cd pallas-dsh-0.3.4
shasum -a 256 -c SHA256SUMS
dsh plugin --profile web add ./dsh-local-pair-0.3.4-macos.tgz
```

Start or restart `dsh web` and open DSH at the `127.0.0.1` address it prints. **Pallas iPhone Control** appears in the sidebar, and also in the plugin settings under **Pallas iPhone**.

## Install the Runner on the iPhone

1. Connect and unlock the iPhone over USB. On first connection, tap **Trust** on the phone.
2. In DSH, open **Pallas iPhone Control → Install and repair**, select the device and click **Install phone control**.
3. Follow the prompts to sign in with your own Apple Account, enter the verification code and confirm Developer Mode on the iPhone. When the signature expires, click **Install phone control** again.

If the Runner is already installed, **Repair control runtime** prepares the iPhone's developer runtime again.

## Pair and open Calculator

1. Put the Mac and the iPhone on the same local network. Click **Create pairing code** on the plugin page and scan it from **Remote Host** in Pallas Agent on the iPhone.
2. On the iPhone, go to **Settings → Phone Control**, turn it on, tap **Allow Computer Control** and keep Pallas Agent in front.
3. In a DSH chat, say "Open Calculator on my iPhone" and confirm on the phone. Each authorization covers one round of actions; authorize again on the phone for the next round.

## Plugin source and packaging

[`Tools/HostPairing`](Tools/HostPairing) contains the DSH plugin, pairing, the web settings panel and the `pallas_iphone` tool. [`Tools/PallasMesh`](Tools/PallasMesh) provides a mesh node that can be packaged alongside it.

```sh
npm ci --prefix Tools/HostPairing --ignore-scripts
npm test --prefix Tools/HostPairing
```

Download `Pallas-Runner-macos-kit.zip` from the [Runner release](https://github.com/deemo0666/pallas-iphone-runner/releases/tag/v1.1.0), then package on a Mac:

```sh
mkdir -p dist
bash Tools/HostPairing/package-mac.sh /path/to/Pallas-Runner-macos-kit.zip dist
```

Source for the Runner, the native installer service and its dependencies is in [Pallas iPhone Runner](https://github.com/deemo0666/pallas-iphone-runner).

## Copyright and license

Copyright © 2026 deemo0666. All rights reserved.

The project's own source code is available for review by people granted access; it is not open source. Use of the official plugin package is set out in [LICENSE.md](LICENSE.md). The Runner and installer service inside the package are covered by `mac/LICENSE.md`; the installer service's LGPL source and relinking instructions are in `mac/InstallerServiceSource.zip`, and third-party licenses are in `mac/ThirdPartyNotices.txt` and `bin/ThirdPartyNotices.txt`.
