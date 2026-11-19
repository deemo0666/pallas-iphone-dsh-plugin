# Pallas iPhone 操控 · DSH 插件

在 DSH Web 里为已经装好 Pallas Agent 的 iPhone 配对和安装操控组件。配对后，可以在 DSH 对话中读屏、点按和打开 App。

[下载 macOS 插件 v0.3.3（ZIP）](https://github.com/deemo0666/pallas-iphone-dsh-plugin/releases/download/v0.3.3/dsh-local-pair-0.3.3-macos.zip)

## 安装到 DSH

需要已配置的 DSH Web 和 macOS 13 或以上。插件中的 iPhone 安装包是 Runner `1.0 (1)`。iPhone 需先装带「允许电脑操控」入口的 Pallas Agent `0.5.1`。使用原账号侧载的 Pallas Agent 需匹配 `0.5.1 (18)` 和原安装器的共享权限。

```sh
unzip dsh-local-pair-0.3.3-macos.zip -d pallas-dsh-0.3.3
cd pallas-dsh-0.3.3
shasum -a 256 -c SHA256SUMS
dsh plugin --profile web add ./dsh-local-pair-0.3.3-macos.tgz
```

启动或重启 `dsh web`，从启动输出的 `127.0.0.1` 地址打开 DSH。侧栏有「Pallas iPhone 操控」，也可以从「设置 → 内置插件 → Pallas iPhone」进入。

## 给 iPhone 安装 Runner

1. 用 USB 接上并解锁 iPhone，首次连接时在手机上点「信任」。
2. 在 DSH 打开「Pallas iPhone 操控 → 安装与修复」。选中设备并点「安装操控组件」。
3. 按提示登录自己的 Apple 账号，完成验证码和 iPhone 上的开发者模式确认。签名到期后可以再点一次「安装操控组件」。

已装好 Runner 时，可以用「修复操控环境」重新准备 iPhone 的开发者运行环境。Pallas Agent 项目见 [pallasai](https://github.com/deemo0666/pallasai)。

## 配对并打开计算器

1. Mac 和 iPhone 连到同一局域网。在插件页点「生成配对码」，在 iPhone 的 Pallas Agent「远程主机」扫码。
2. 在 iPhone 的「设置 → 手机操控」打开开关，点「允许电脑操控」，保持 Pallas Agent 在前台。
3. 在 DSH 对话里说「在我的 iPhone 上打开计算器」，在手机上确认打开。每次授权供一轮操作，下一轮在手机上再次授权。

## 插件源码与打包

[`Tools/HostPairing`](Tools/HostPairing) 是 DSH 的插件、配对、Web 设置面板和 `pallas_iphone` 工具。[`Tools/PallasMesh`](Tools/PallasMesh) 提供可一同打包的 Mesh 节点。

```sh
npm ci --prefix Tools/HostPairing --ignore-scripts
npm test --prefix Tools/HostPairing
```

从 [Runner Release](https://github.com/deemo0666/pallas-iphone-runner/releases/tag/v1.0.0) 下载 `Pallas-Runner-macos-kit.zip`，然后在 Mac 上打包。

```sh
mkdir -p dist
bash Tools/HostPairing/package-mac.sh /path/to/Pallas-Runner-macos-kit.zip dist
```

Runner、原生安装服务和其依赖源码见 [Pallas iPhone Runner](https://github.com/deemo0666/pallas-iphone-runner)。
