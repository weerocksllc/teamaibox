<!-- doc-navigation:start -->
[English](SOURCE-INSTALL.md) · [简体中文](SOURCE-INSTALL.zh-CN.md) · [繁體中文](SOURCE-INSTALL.zh-TW.md) · [日本語](SOURCE-INSTALL.ja.md) · [한국어](SOURCE-INSTALL.ko.md) · [Français](SOURCE-INSTALL.fr.md) · [Deutsch](SOURCE-INSTALL.de.md) · [Español](SOURCE-INSTALL.es.md) · [Português](SOURCE-INSTALL.pt-BR.md) · [Русский](SOURCE-INSTALL.ru.md) · [العربية](SOURCE-INSTALL.ar.md) · [हिन्दी](SOURCE-INSTALL.hi.md) · [Bahasa Indonesia](SOURCE-INSTALL.id.md) · [Italiano](SOURCE-INSTALL.it.md) · [Türkçe](SOURCE-INSTALL.tr.md) · [Tiếng Việt](SOURCE-INSTALL.vi.md) · [ไทย](SOURCE-INSTALL.th.md)

[Team AI Box — README](../README.zh-CN.md)
<!-- doc-navigation:end -->

# 从公开源码克隆安装

此入口会准备所需的公开构建输入、构建应用镜像并生成完整安装包，然后执行安装。构建支持断点续跑；只有最终安装就绪检查通过，才能视为安装完成。下载或预检成功本身并不代表安装成功。

将生成的模型、容器镜像、安装包、测试记录和凭证保留在存储库之外。不保证第三方镜像的可用性；已验证的便携式缓存和离线包如下所述。

在运行 Ubuntu 24.04、运行 Docker/Compose、NVIDIA 和 KVM 的新 DGX Spark 上，克隆公共存储库并从其根目录运行：

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

如果中国大陆网络无法访问上游模型或镜像地址，可在同一入口启用区域下载源：

```sh
sudo bash install/from-source.sh --region cn
```

这是**在线源构建然后离线安装**，而不是离线源构建。它自动准备缺少的构建工具，下载六个模型输入，构建和组装 Android 和所有应用程序映像，量化两个源模型，收集固件/主机包，创建完整的离线包并运行其现有安装程序。它不会取代 Docker/NVIDIA、重新启动 Docker 守护程序、清除现有安装或更改主机路由、DNS 或 VPN 设置。模型、访客登录状态和私人营销网站不是从其他安装中获取的。

默认工作空间为`/var/tmp/teamaibox-source-build`；下载缓存和每阶段日志都位于克隆之外。安装默认为 `/srv/teamaibox/installation`。预计会有大量下载和数百 GB 的临时磁盘使用量。模型加载和 GPU 量化可能需要大量时间；没有承诺固定的完成时间。

## 断点续跑与状态

中断后，**重新执行完全相同的命令**，并保留工作目录。运行中的构建会通过写入锁阻止另一构建同时写入；已完成的阶段文件和镜像在复用前会先校验。失败记录保留用于诊断，下次只续跑失败阶段。已下载的模型字节范围和通过校验的文件均会保留。`state.json` 记录当前阶段及其日志目录。官方模型下载采用受控的文件和字节范围并发；区域源采用较低并发以减少限流。每个文件的传输或复用字节进度与最终上游哈希校验分别报告。虚拟设备工具的编译也可在没有登录用户主目录的系统服务下运行：其独立构建缓存位于安装资产之外。

源码变化后必须使用新的 `--work-dir`；可通过 `--cache-dir /path/to/public-cache` 复用下载缓存。源码指纹会阻止不同代码版本的产物被悄悄混用。不要因此重置既有安装：只有当前工作目录中同一安装包的安装才能续跑，其他安装应使用对应的升级流程。

有用的模式：

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh --region cn --download-models-only
sudo bash install/from-source.sh --region cn --build-only
```

`--check` 仅作只读检查，不保证之后的下载一定成功。仅下载或仅构建模式均不代表安装已就绪。

## 区域来源和完整性

中国模式使用 `https://hf-mirror.com` 下载模型，使用 `https://docker.m.daocloud.io` 获取按摘要锁定的 Docker Hub 镜像。这些是第三方镜像站，并非 Weerocks 或模型发布者运营的服务。模型 Git 提交由产品配置锁定；经过验证的 Git 树及 LFS 指针确定文件的预期大小和哈希，不能仅凭镜像站的 API 响应建立信任。Docker 会验证锁定的清单和镜像层摘要。未锁定的标签不会自动重定向（Go 构建工具有独立的摘要锁定）。NVIDIA 镜像仍从其发布者的镜像仓库获取。TLS 校验始终启用，不向模型镜像站发送账户令牌。

可通过 `--model-endpoint` 和 `--registry-mirror` 指定自己的 HTTPS 源站，地址不得包含凭据或查询参数。专用 Docker 包装器只影响本次构建，不修改系统 Docker 守护进程或其他项目。SDK 元数据和许可归档仍来自权威发布者的 HTTPS 地址；镜像站不能自行编造可信哈希。

镜像站可能限流或不可用。模型下载限制并发，并遵守冷却等待。任何脚本都不能保证所有网络均可访问全部上游。如果官方源和区域源都不可达，可在网络可用的兼容机器上准备下载缓存或完整安装包，再复制过去：

- `--download-models-only --cache-dir <public-cache>` 准备经过校验的模型文件及可续传缓存。复制该目录后，在目标机器用 `--cache-dir` 指定它。每个复用模型仍会根据锁定的身份校验。这份缓存**不是**完整离线安装包。
- `--build-only` 生成完整离线安装包。复制 tar 归档及校验文件，验证并解包后，在包内执行 `sudo ./install.sh`。这是用于断网主机的离线安装路径，不要求目标机启用 VPN，也不依赖开发盒。

绝不能用运行中的 Docker 数据目录、虚拟机磁盘、浏览器配置、账户数据库、凭据或私有缓存替代公开构建输入。不要关闭校验和验证，也不要把登录页或人机验证页面当作模型文件。

## 许可和首次使用

构建前阅读 `THIRD_PARTY_NOTICES.md`、Android SDK 条款及各模型许可证。下载第三方组件不会将其变成 MIT 资产，也不代表取得 Google 认证或再分发权。Windows/Linux ISO 仍由用户自行提供。出厂登录为 `admin/admin`，开放使用前必须修改。安装器会独立生成服务凭据，并报告真实就绪状态。

完成后，在同一局域网打开 `https://<BOX_LAN_IP>/`，将地址替换为 Spark 当前的物理网络地址，而不是 Docker 网桥或 VPN 地址。源码工作目录的 `state.json` 记录构建进度；已安装系统的 `/srv/teamaibox/installation/readiness.json` 记录安装检查。编译成功或容器端口健康检查，都不能代替应用实际可见的端到端使用结果。

投屏运行时必须包含 UxPlay 接收器、独立 D-Bus、Avahi 发现程序及其媒体插件。公开镜像的最终构建会检查这些可执行文件，仅有客户端库不够。全新安装会将桌面代理和网关与其他依赖 API 网络命名空间的服务一起注册，使整组 API 升级后仍保留桌面连接路径。维护时不要只重建这一组中的部分服务。
