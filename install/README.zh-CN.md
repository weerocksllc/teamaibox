<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.zh-CN.md)
<!-- doc-navigation:end -->

# Team AI Box离线打包工具

原始安装程序已获得 MIT 许可。软件包在其文件哈希清单中包含根许可证、第三方清单和许可证文本。这不会将模型、Google 服务、驱动程序或容器依赖项重新许可为 MIT。分发前请阅读[发布边界](../docs/open-source/RELEASING.zh-CN.md)；现有的完整测试包不会自动获得重新分发许可。

客户在准备好的包内运行`sudo ./install.sh`。维护者使用 `build-package.sh` 构建该软件包。离线客户不需要 Git、Node、Go、pip 或公共包存储库。

要从公共克隆自动下载、构建和安装，请运行 `sudo bash install/from-source.sh`。中国的网络可以使用`--region cn`。操作、恢复和离线传输请参见[SOURCE-INSTALL.md](SOURCE-INSTALL.zh-CN.md)。支持续跑；只有最终的就绪结果才能确定安装完成。成功的预检或下载还不够。

目标是一个新的 DGX Spark，其工厂 Ubuntu 24.04 ARM64 系统和工作 Docker 引擎、Compose v2、NVIDIA Container Toolkit/GPU 和 KVM。安装程序不会替换 Docker/NVIDIA、重新启动 Docker 或复制开发设备的帐户、数据库、密钥或虚拟机。

> 私有安装验收记录保留在历史开发存储库中。它们既不是公共源文件，也不是构建输入。现有的首次安装、恢复和启动恢复证据不仅仅是为了源发布而重新运行，并且不限定任意新建的映像或授予第三方二进制文件的重新分发权利。

## 维护者：准备发布输入

**对于全新的公共 GitHub 构建，请从 [PUBLIC-BUILD.md](PUBLIC-BUILD.zh-CN.md) 开始。** 它涵盖公共镜像、相机运行时、模型下载/量化和固件，无需来自开发设备的镜像。下面的分层镜像助手支持已验证工件的增量更新；它们不是全新构建的先决条件。

准备工作可以使用互联网。从提供的包安装不得下载依赖项。打包主机需要Python 3.10+、PyYAML、Git、Docker、`dpkg-deb`和足够的存储空间。模型和镜像可以很大；打包器保留提取的树和 `.tar`，根据实际输入估计空间。它既不扫描整个开发设备，也不从正在运行的容器导出可写层。

1. 为所有必需的角色准备 **一个发行版本** 的 ARM64 映像。使用 `deploy/images/`、`deploy/appliance/` 和相应的 guest/model 目录下的构建入口点。平台API、节点代理、调度程序和代理控制器必须支持本地镜像ID； PostgreSQL 映像必须包含当前迁移清单，包括迁移 116。打包程序不会将任意旧映像编译为当前映像。通过经过验证的相同版本父映像，使用 `build_runtime_images.py --bases … --node-agent-binary … --output …` 构建五个后续映像。 `--bases` 是 JSON 角色到完整镜像 ID 映射。首先使用 `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build` 构建节点代理。该帮助器禁止拉取/网络构建，记录父/源身份，并在不部署或更改实时标签的情况下创建新镜像。干净的 Android ROM 还需要当前的控制网络适配器。使用 `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>` 将 `phone_network.py` 添加到两个 ROM 后续层，无需网络访问或 ROM 数据更改。它记录准确的镜像 ID 和源摘要。将 Android sidecar 绑定到两个新 ID，而不是以前的 ID。使用 `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>` 构建网络和九个官方应用程序。首先按照 `apps/web/package.json` 的指定构建网络。该帮助程序使用生产 Dockerfile，将 Web 目录修复为 `/opt/teamaibox/web`，并将镜像文件与当前构建输入哈希值进行比较。不要假设开发容器映像是完整的 Web 构建：它可能依赖于额外的静态目录变量或包含旧目录。此离线助手不会部署。将所有十个新镜像 ID 放入发布输入中。
2. 收集六个模型的完整、干净的目录：配置、分片、标记器、所需的代码和许可证。还要准备两个干净的 Android 映像：UEFI `CODE.fd`/`VARS.fd`、`virtio.iso` 和绘图运行时脚本。请勿收集电话实例目录、用户磁盘、Google 登录状态、用户 ISO 或全局凭据。 Android ROM 已位于 `phone-runtime` / `phone-google-runtime` 内；不要复制第二个磁盘。 `android-standard` / `android-google` 资产目录仅包含来源、许可证和 `manifest.json`：`schemaVersion: 1`、`androidVersion: "17"`、`baseBuildId: "16102939"`、 `systemFamily: "standard"` 或 `"google-play"` 和 `runtimeImageId: "sha256:…"`。 ID 必须与导出的运行时映像匹配。驱动目录仅包含`virtio.iso`；还包含 `windows.iso` 的开发目录被拒绝。
3. 构建两个捆绑的 Linux ARM64 主机工具，而不将它们安装在构建主机上：

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. 在连接互联网的 ARM64 构建主机上，使用显式本地 Ubuntu 24.04 映像收集主机工具依赖项。使用在该主机上验证的映像 ID，而不是从开发设备复制的 ID：

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   仅收集 cryptsetup、ext4、USB/摄像头、QEMU 镜像工具、网络和小型系统实用程序的依赖项。禁止使用 Docker、containerd、NVIDIA、CUDA 和内核替换包。安装仅提供缺少的工具； apt 使用 `--no-download --no-remove` 读取软件包的本地文件存储库，无需在线回退。

5. 生成发布输入清单并提供**显式工件路径和本地镜像内容 ID**：

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   该模板包含全部 41 个镜像角色和 12 个外部资产类别；另一种工厂资产是由工具生成的。占位符不能输入包。 `sourceCommit` 必须与结账相符，`agentVersion` 实际代理版本，以及 `hostPackageCollection` 步骤 4 `collection.json`。构建主机路径是集合输入，而不是客户运行时配置。使用当前工厂生成器：绘图 UI 的 `drawing.automatic` / `drawing.fast` 路由必须与本地模型配置匹配。仅工作人员健康状况或直接模型调用并不能建立应用程序就绪状态。打包拒绝缺少这些映射的过时工厂模板。

映像角色合同由 `python3 install/package.py --describe-contract` 报告：

- 核心、网络、团队驱动、消息传递、网关、调度程序、维护、插件、动态代理沙箱和包源网关。
- 九个应用程序插件、六个办公室模型工作进程和按需 ASR/扬声器运行时间。
- 标准 Android、Google Android、计算机运行时和网络显示/音频网关。
- 广播接收器、媒体处理和 SFU。

两个角色可以共享一个图片内容ID；其存档仅导出一次。模型分片索引也会被检查：匹配的文件哈希值不能成为丢失分片的借口。主机工具必须是实际的 ARM64 ELF 二进制文件。

## 构建包

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

输出是 `teamaibox-<releaseId>-linux-arm64.tar`、其 `.sha256` 文件和提取的目录。在发布最终校验和之前，复制、镜像导出、散列和归档发生在临时目录中。现有输出不会被覆盖；中断的构建一定不能看起来像完整的发布。对于仅安装程序更改且映像标识未更改，请使用 `--image-cache <previous-extracted-package>`。在通过实际映像 ID 重用其档案之前，会验证整个旧包，然后再次验证新包。不会从旧安装或容器可写层获取任何数据。这可以避免再次导出数百 GB 的相同镜像。

正常版本要求其捆绑的源文件属于声明的 Git 提交。显式的 `--allow-working-tree` 创建开发候选；它的清单记录了 `candidate: true` 和更改的文件。通过重点验收不会将未提交的源代码转变为已发布的版本。

封装布局：

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

与 `./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64` 独立验证。这会检查完整性；它不能证明在新硬件上成功启动。

## 客户：离线安装和恢复

阅读[软件包安装指南](PACKAGE-README.md)。默认根目录是 `/srv/teamaibox/installation`。 LUKS/ext4 仅在新的 `volume/data.img` 内部创建，而不是在系统磁盘或现有磁盘上创建。数据池使用可用存储减去物理安全裕度，而不是固定的 256 GiB 限制。模型、业务文件和访客数据驻留在加密卷中；现有的 Docker 管理容器镜像。

全新安装会创建管理员 `admin`，初始密码为 `admin`。普通用户由管理员创建。发货/使用前请更改初始密码。这仅适用于空帐户数据库：恢复、重新运行、重新启动和升级不会重置现有帐户或密码。设备身份、服务凭证、证书和管理员恢复代码是独立生成的，而不是从其他设备复制的。初始 GPU 内核缓存准备工作使用捆绑的工具和模型在设备上运行；保留兼容的缓存。启动恢复首先恢复数据和设备服务，然后恢复核心服务和单个AI工作人员。安装程序仅在安装期间运行；它不添加常驻安装程序管理器。

中断后，重复原来的命令。验证已完成的步骤；不要通过删除数据或重新创建容器来隐藏冲突。重新运行已完成的相同版本安装只会对其进行检查；不同版本使用正式升级路径。失败详细信息位于安装根目录下的 `install-state.json`、`readiness.json` 和阶段记录中。

## 验证边界

安装程序特定的测试使用小型结构工件、临时文件和隔离的离线数据库/Docker 守护进程。他们不得访问业务数据库或挂载现有虚拟机磁盘。真正的全新安装需要为此目的明确指定的兼容的 DGX Spark；不要删除商业设备。验收涵盖新安装的最低启动、恢复和引导恢复，而不是不相关的业务测试。源代码发布准备本身不会删除、重新安装或部署现有设备。

在构建主机上，运行 `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>` 将完整包导入到具有空缓存且没有公共网络的单独 Docker 守护进程中。它不会调用全新安装脚本、使用 GPU、挂载客户目录或重新启动系统 Docker。其报告明确没有声称完整的硬件安装。测试镜像保留在专用的测试目录中，需要额外的磁盘空间，并且不会进入系统 Docker 的镜像存储。
