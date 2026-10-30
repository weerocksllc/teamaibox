<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.zh-CN.md)
<!-- doc-navigation:end -->

# 从公共源构建一个设备

新的编排入口点记录在 [SOURCE-INSTALL.md](SOURCE-INSTALL.zh-CN.md) 中。它可以自动执行以下构建步骤；那里说明了其完整的设备验证状态。这些手动构建步骤仍然可供维护人员和各个阶段的诊断使用。

这是源到包的路径。它不会导入以前的 Team AI Box 安装、其容器、帐户、证书、来宾或数据库。构建机器需要互联网接入；生成的完整包将离线安装。客户单独提供 Windows/Linux 安装介质。

使用 Linux ARM64 (Ubuntu 24.04)、Docker/BuildKit、Python 3.10+、PyYAML、jq、Git、Go 1.26 和足够的磁盘空间来下载源代码、构建层和最终的未压缩包。模型量化还需要具有足够可用内存的兼容 NVIDIA GPU。未经计算机所有者许可，请勿停止其他工作负载来获取该内存。 Docker 和 NVIDIA 是先决条件，而不是安装程序替换的组件。

从新的公共检出目录运行命令。将 `BUILD` 设置为检出目录 **外部** 的新绝对构建目录。不得提交输出、模型和报告。每个助手都会拒绝占用的输出，除非它记录了特定的恢复操作。使用成功报告的引用/ID，而不是从其他人的计算机复制的镜像名称。本地 Docker 内容 ID 不是可下载的注册表参考； Dockerfile 父参数需要相应的本地标记或合格的上游摘要。

## 1. 服务和应用

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host` 影响在线**构建**，而不是安装的服务网络。节点依赖阶段允许每次连接尝试 2 秒，而不是节点默认的 250 毫秒。这使得官方 npm 下载可在较高延迟的链接（包括用户管理的 VPN）上使用，而无需切换注册表、禁用 IPv6 或削弱 TLS/包完整性检查。该设置是构建阶段参数，而不是已安装应用程序中的环境更改。对于较慢的链接，直接 Docker 构建可以覆盖 `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`。 Web 映像构建自己的锁定依赖项和资产。节点服务共享新构建的 API 依赖闭包。 OCR 包括其公共适配器；它不需要来自另一个项目的未发布的工作程序包。翻译使用固定的公共 NVIDIA vLLM 镜像。嵌入、批量 ASR 和投射媒体有意共享各自的公共运行时镜像。该计算机映像构建了经过签名验证的 QEMU 11.1.1，支持 ARM TPM/PPI、KVM、VNC 和 PulseAudio，保留了原始 Windows 运行时的功能。 Debian 提供运行时库，但其较旧的打包 QEMU 不得替换此可执行文件。最终镜像检查 ARM TIS `ppi` 属性和 PulseAudio 后端，并包括匹配的 RAM 帧缓冲区 ROM。有关有界运行时探测和数据保留更新要求，请参阅[虚拟计算机运行时指南](../deploy/windows-computer/README.zh-CN.md)。

每个角色都有一个日志。失败的报告保留成功的角色输出；仅构建失败的角色并稍后合并成功的报告。不要将正在运行的开发容器替换为丢失的映像。

## 2. 无帐户 Android 和相机运行时

这些锁锁定了 Google 的 AOSP 构建、主机包、内核输入和源代码修订。使用前会检查下载内容。组装期间不会启动任何来宾。

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

对于相机 APK 补丁，请安装 Google 的公共 Android 命令行工具、平台 `android-36.1`、构建工具 `36.1.0` 和支持 Java 版本的 JDK
8. 将 `ANDROID_SDK_ROOT` 和 `JDK_HOME` 设置为这些工具目录。这些工具是构建依赖项，而不是导出的 Android 用户配置文件。在 ARM64 Linux 上，Google 捆绑的 `zipalign` 可能仅限 x86：安装 Ubuntu 的 ARM64 `zipalign` 软件包并传递下面的 `--zipalign /usr/bin/zipalign`。 D8 和 apksigner 是 Java 程序。 APK 构建也可以在单独的受支持的 SDK 主机上运行；仅传输其两个输出文件（`Camera2.apk`、`camera-preview.json`），而不传输该主机的 Android 设置或用户配置文件。

从干净的 AOSP 构建中提取库存 APK（输出目录必须存在并且可由构建容器写入）：

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

APK 保留已知的**公共 AOSP 测试签名者**，而不是私有产品密钥。帮助程序验证原始证书和生成的证书以及未更改的 APK 资源，并删除临时签名材料。这不是帐户或 Google 设备身份。

当前完整的安装程序合同还包括一个实验性的 Google Android 变体。其公共输入锁和签名检查**不**授予Google认证或再分发权利。仅在适用的第三方条款内构建/使用它；请勿将生成的完整捆绑包发布为不受限制的 MIT 下载。

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. Publisher 模型文件和公共量化构建步骤

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

所有模型下载都使用 `deploy/compute/*profile*` 中的不可变修订版和发布者的 Git/LFS 哈希值。可选的 `--cache <directory>` 是只读的，仅当文件的字节与发布者匹配时才接受文件。这不是一种随意导入已安装模型目录的方法。 ASR 的独立 MIT 文本固定到原始 Whisper 版本，因为转换后的模型快照仅声明许可证。 OCR 保留其自己的许可证，而不是 MIT。固定的翻译和嵌入模型卡声明 Apache-2.0 而不传送其独立文本；他们的助手包括校验和固定的 Apache 许可证以及检查该声明后的出处记录。

中断的匹配下载支持 `--resume`。 `--transfer ranges` 使用有界可恢复 HTTP 范围； `--transfer huggingface` 需要官方的 `huggingface_hub`/`hf_xet` 软件包并禁用令牌使用。部分和下载缓存保留在可发布模型目录之外。每次传输都强制执行校验和。不要削弱它们的 HTML 登录/挑战页面或截断的下载。

量化使用 ModelOpt 的公共合成校准数据在单独的构建容器中离线运行，从不聊天历史记录。只有 `build.json` 为 `quantized` 的输出才能提供 `assistant-model` 和 `translation-model`；选择它们的 `model/` 子目录，而不是原始源或整个构建工作区。验证输入后，Linux 构建建议内核释放这些特定文件的缓存页面。这可以避免 GB10 共享内存上立即释放的 GPU 内存读数产生误导；它不会删除权重、清除主机范围的缓存或停止工作负载。对于一个 GB10 GPU，助手从 Linux `MemAvailable` 进行预算，并为校准和主机预留容量。它拒绝容量不足，而不是默默地接受以 CPU 为主的构建。当完整模型适合时，明确的 ModelOpt 预算可以避免 Accelerate 不必要的 CPU 卸载导出路径。构建容器还遵循 [NVIDIA 的量化启动要求](https://build.nvidia.com/spark/nvfp4-quantization/instructions) 设置无限锁定内存和 64 MiB 堆栈。这些设置的范围仅限于构建容器，而不是主机范围的限制。

## 4. 完整的包输入

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

合并必须报告 **41 个角色，并且没有缺失的角色**。它验证镜像架构/内容 ID 并拒绝冲突的输出。资源仅包含上游 UEFI 固件（包括新的变量存储模板）、校验和固定的 virtio 驱动程序 ISO、源绘图运行时以及绑定到新建映像的 Android 通知。 ISO 不是 Windows 安装介质。其校验和相同的 Microsoft OpenVMM 镜像避免依赖交互式 Fedora 下载页面。

按照 [README.md](README.zh-CN.md) 中的说明使用 `collect_host_packages.py` 收集主机包，然后使用 `prepare-release.py --template` 生成模板。从`images.json`填充其镜像映射；填充模型输出 `resources/assets.json` 和 `guest-tools` 中的所有 12 个资产角色。将 `sourceCommit` 设置为检出目录版本和实际代理版本。不接受占位符或以前的安装配置。

运行 `prepare-release.py --inputs … --output …`，然后使用准备好的版本运行 `build-package.sh`。修改/未提交的源需要显式的 `--allow-working-tree` 候选标志；它们不是已发布的提交。请参阅[PACKAGE-README.md](PACKAGE-README.md)进行安装。新的空白帐户数据库获取`admin/admin`；所有服务凭证和设备身份都是独立生成的。单独构建并不能证明安装成功。

## 历史分层构建步骤和出版物检查

保留较旧的诊断/分层 Dockerfile 用于源代码维护，不被此管道使用。他们的 `BUILD_PARENT_N` 参数故意没有私有镜像默认值。提供您构建的兼容父级，或使用上面的公共管道；不要猜测不可用的开发摘要。

在发布之前，运行源防护和秘密扫描器，单独查看历史记录，并排除所有构建目录、包、来宾磁盘、帐户数据和私人网站。包含本地路径的报告属于公共树之外。这项工作的验证仅限于构建输入闭包、工件身份、安装和新安装的最小服务路径；不重新办理无关业务受理。
