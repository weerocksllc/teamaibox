# Team AI Box 离线安装包工具

自研安装器采用 MIT，打包时会附上根许可证、第三方清单及许可文本，并计入文件哈希。
这不代表模型、Google 服务、驱动或容器内所有软件都变成 MIT。
公开分发前请阅读 [发行范围](../docs/open-source/RELEASING.md)；既有完整测试包不自动获得公开分发授权。

客户入口是**包内的 `sudo ./install.sh`**。维护者入口是本目录的
`build-package.sh`。客户不需要 Git、Node、Go、pip 或公网软件源。

从公开 clone 自动下载、构建及安装的新入口为
`sudo bash install/from-source.sh`，国内网络可加 `--region cn`。
完整操作、续传和离线转移说明见 [SOURCE-INSTALL.md](SOURCE-INSTALL.md)。
该入口支持断点续跑；以最终安装就绪结果为准，预检或单项下载成功不代表整机安装完成。

目标：尚未安装 Team AI Box、Ubuntu 24.04 ARM64 原厂系统的 DGX Spark，
现有 Docker Engine、Compose v2、NVIDIA Container Toolkit/GPU 和 KVM 可用。
不重装 Docker/NVIDIA，不重启 Docker，不复制开发盒账户、数据库、密钥或虚拟机。

> 私有安装验收记录保留在原开发仓库，不随公开源码分发，也不是构建输入。
> 原有首次安装、续装及开机恢复证据不因开源准备而重测；它们不等于任意自行
> 构建的镜像或第三方二进制包已完成验收或取得公开分发权。

## 维护者：准备发行输入

**从公开 GitHub 全新构建请先按 [PUBLIC-BUILD.md](PUBLIC-BUILD.md) 执行。**
它覆盖公开镜像、摄像头运行时、模型下载/量化及固件，不需要开发盒的本地镜像。
下文旧镜像后继层工具只用于已有经验证制品的增量更新，不是全新构建的前置条件。

准备阶段允许联网；安装包交给客户后不得再下载依赖。
打包机需要 Python 3.10+、PyYAML、Git、Docker、`dpkg-deb` 及足够空间。
模型和镜像可很大，打包器保留解包目录及 `.tar`，会按实际输入预估空间。
打包不会扫描整个开发盒，也不会从正在运行的容器导出可写层。

1. 在发布构建环境准备**同一发行版本**的 ARM64 镜像，包含下面全部角色。
   使用仓库 `deploy/images/`、`deploy/appliance/` 及相应 guest/模型目录的构建入口。
   平台 API、Agent、调度器和 Agent 控制器需包含本提案的本地 image ID 兼容改动；
   PostgreSQL 镜像需携带当前 migration manifest（包含迁移 116）。
   本工具是发行制品的打包器，不会把任意旧镜像自动编译成新版本。
   已核实同版依赖镜像时，也可用 `build_runtime_images.py --bases … --node-agent-binary … --output …`
   构建这五个后继镜像；`--bases` 是角色到完整镜像 ID 的 JSON，Node Agent 二进制须先用
   `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build` 构建。该工具禁止 pull/联网构建，
   记录基底和源码身份，只生成新镜像，不部署、不替换线上标签。
   Android 的现有干净 ROM 也必须带当前控制网络适配器。使用
   `build_phone_images.py --bases <两个 phone 角色的镜像 ID JSON> --output <新目录>`
   将仓库的 `phone_network.py` 加入两种 ROM 的后继层；构建无网络、不改 ROM 数据，
   输出精确镜像 ID 和源码摘要。Android sidecar 必须绑定这两个新 ID，不能沿用旧 ID。
   网页和九个官方应用使用 `build_application_images.py --node-base <干净 ARM64 Node 镜像 ID> --guacamole-image <离线 Guacamole 镜像 ID> --output <新目录>`
   从当前代码构建；先按 `apps/web/package.json` 完成网页 build。该工具使用正式 Dockerfile，
   固定网页目录 `/opt/teamaibox/web`，逐项比较镜像内文件与当前构建输入的哈希。
   不把开发容器当前使用的镜像直接当作完整网页：它可能需要额外的静态目录环境变量，
   或同时包含旧目录。构建不联网、不部署，新输出的十个镜像 ID 必须写入发行输入。
2. 明确收集六套模型的完整干净目录（配置、分片、tokenizer、必要代码和许可文件），
   两种 Android 的干净发行镜像、UEFI `CODE.fd`/`VARS.fd`、`virtio.iso`、绘图运行脚本。
   不收集手机实例目录、用户盘、Google 登录态、用户 ISO 或全局凭据。
   Android 的 ROM 已包含在对应 `phone-runtime` / `phone-google-runtime` 镜像里，不再复制
   第二份磁盘。`android-standard` / `android-google` 资产目录只放来源说明、许可和
   `manifest.json`：`schemaVersion: 1`、`androidVersion: "17"`、`baseBuildId: "16102939"`、
   `systemFamily: "standard"` 或 `"google-play"`、`runtimeImageId: "sha256:…"`。
   此编号必须与实际导出的运行镜像一致。驱动目录只收集 `virtio.iso`，不要指向混有
   `windows.iso` 的开发目录；打包器会拒绝它。
3. 编译随包的两个 Linux ARM64 宿主工具，构建过程不安装到当前宿主：

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. 在可联网的 ARM64 构建机中，用明确的本地 Ubuntu 24.04 镜像收集宿主工具依赖。
   镜像 ID 使用该构建机实际核实的值，不能照抄开发盒 ID：

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   只收集 cryptsetup、ext4、USB/摄像头、QEMU 镜像工具、网络及系统小工具的依赖。
   禁止 Docker、containerd、NVIDIA、CUDA 和内核替换包。目标只补缺项；
   apt 只读取包内 file 软件源并使用 `--no-download --no-remove`，没有在线回退。

5. 生成发行输入清单，填入**明确的制品目录和本地镜像内容 ID**：

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   清单模板包含所有 41 个镜像角色和 12 类外部资产；另一个 factory 资产由工具生成。
   占位字符串不能出包。`sourceCommit` 必须对应当前 checkout；`agentVersion` 对应
   实际 Agent 构建版本。`hostPackageCollection` 指向第 4 步的 `collection.json`。
   输入中的构建机路径只在收集时使用，不写入客户的运行配置。
   工厂模板必须来自本次配置生成器：绘图网页使用的 `drawing.automatic` / `drawing.fast`
   要与后台本机模型配置对应，不能只凭 Worker 健康或直接模型调用认定应用可用。
   打包会拒绝遗漏这些映射的旧工厂模板缓存。

镜像角色按 `python3 install/package.py --describe-contract` 输出为准：

- 核心、网页、网盘、消息、网关、调度、维护、插件、Agent 动态沙箱与软件源网关。
- 九个应用插件，六个办公模型 worker，以及按需 ASR/说话人运行镜像。
- 标准 Android、Google Android、电脑运行时、网页显示/音频网关。
- 投屏接收、媒体处理及 SFU。

两个角色可以指向相同镜像内容 ID，归档只导出一次。模型自身的分片索引也会被核对，
不能以“文件哈希都对”为理由省略一个分片。宿主工具必须是真正的 ARM64 ELF。

## 打包

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

产物为 `teamaibox-<releaseId>-linux-arm64.tar`、同名 `.sha256` 以及解包目录。
先在临时目录完成复制、镜像导出、哈希核对和归档，最后发布校验文件。
同名产物不会被覆盖，构建中断不会留下一个看似成功的最终包。
仅安装器改动、镜像身份未变时，可添加 `--image-cache <此前解包目录>`：
先完整校验旧包，再按实际 image ID 复用其镜像归档；新包重新校验并发布，
不从旧安装目录或容器可写层取数据。这样不必重复导出几百 GB 的同一镜像。

正常发行要求随包源文件均属于声明的 Git commit。开发候选包可以明确添加
`--allow-working-tree`，其 manifest 会标记 `candidate: true` 并记录变更文件；
即使候选包已通过专项验收，也不能把它冒称为已经提交的正式发行版本。

实际包结构：

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh、installer.py、offline_common.py、offline_host_packages.py
  README.zh-CN.md、release.json、checksums.sha256
  images/          # 按内容 ID 去重的 Docker 归档
  assets/          # 按角色分隔的模型、Android、电脑、工具、factory 配置
  host-packages/   # .deb 完整依赖集
  runtime/         # 安装适配器和既有恢复工具的模块闭包
```

独立核对：`./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64`。
这只是完整性核对，不代表已在新硬件成功启动。

## 客户：离线安装及续装

见包内 [README.zh-CN.md](PACKAGE-README.md)。默认安装根为
`/srv/teamaibox/installation`，只对本次新建的 `volume/data.img` 创建 LUKS/ext4，
不会格式化系统盘或现有磁盘。数据池按实际可用空间扣除物理余量准备，不再固定为
256 GiB；模型、业务文件和 guest 数据放在加密卷内，镜像由现有 Docker 管理。

全新安装自动创建管理员 `admin`，初始密码 `admin`，客户打开网页即可登录；普通用户由管理员创建。
建议交付使用前修改初始密码。仅空白账号库适用，重跑/重启/升级不重置已有账号和密码。
设备身份、服务凭据、证书和管理员恢复码仍各自独立生成，不复制其他盒子的用户数据。
第一次 GPU 内核缓存准备在盒子上计算，但工具及模型都在镜像/包内，兼容缓存保留。
开机沿用现有恢复工具：先恢复数据和设备，再恢复核心与各个 AI worker。
只有首次安装期间运行安装器，不增加常驻的安装管理进程。

中断后原命令续装；已完成步骤先核对，不能用删除数据或重建容器掩盖冲突。
同版本完成后重跑只读检查，不进行升级。不同版本走已有正式升级流程。
失败报告位于安装根下 `install-state.json`、`readiness.json` 和各阶段记录中。

## 验证边界

安装专项测试使用小型结构性制品、临时文件、临时无网络数据库/独立 Docker daemon。
这些环境不得访问业务数据库或挂载现有虚拟机盘。
真正的新机实装须在明确可用于全新安装的兼容 DGX Spark 上进行，不得为此清空当前业务盒。
安装验收仅验证新安装最小启动和重跑/开机恢复，不重复无关业务验收。
开源准备没有重新清空、重装或部署任何现有设备。

构建机可用 `sudo python3 install/verify_bundle_offline.py --package <解包目录> --output <新测试目录>`
把完整包导入独立、空缓存、无公网网络命名空间的 Docker daemon。它不调用新机安装脚本，
不使用 GPU，不挂载客户目录，也不重启系统 Docker。报告会明确标注未验证整机实装。
测试镜像保留在指定测试目录，需要额外磁盘空间，不写入系统 Docker 的镜像库。
