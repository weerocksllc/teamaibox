<!-- Generated from docs/readme-locales/ and docs/readme-features/zh-CN.json by tools/render-readmes.mjs. -->
# Team AI Box — 专为 NVIDIA DGX Spark 打造的开源软件

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

**让 NVIDIA DGX Spark 成为整个团队的 AI 工作空间。** 在 NVIDIA DGX Spark 上运行本地 AI、图像生成和文档工具。Team AI Box 将团队文件、即时通信与虚拟设备整合到一个开源的浏览器工作空间。

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

[完整功能清单](#features) · [在全新 DGX Spark 上安装](#install) · [欢迎一起贡献](#contribute)

## 为什么选择 Team AI Box？

- **一台盒子，一个工作空间。** AI、协作和虚拟设备使用统一界面与账户体系。
- **本地 AI 优先。** 在 Spark 上运行模型推理，也可按需接入外部模型 API。
- **专为 DGX Spark 打造。** 支持 Ubuntu ARM64、NVIDIA GPU 容器和 KVM 虚拟化。
- **可以共同改进。** 自研代码采用 MIT 协议；界面支持 17 种语言、明暗主题并记住手动选择，默认英文。

## 真实工作空间截图

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/zh-CN/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/zh-CN/workbench-light.jpg">
  <img src="docs/assets/screenshots/zh-CN/workbench-light.jpg" alt="面向 NVIDIA DGX Spark 的 Team AI Box 工作台，展示 AI 应用与团队工具 — 简体中文" width="1280">
</picture>

[浅色截图](docs/assets/screenshots/zh-CN/workbench-light.jpg) · [深色截图](docs/assets/screenshots/zh-CN/workbench-dark.jpg)

<a id="features"></a>

## 完整功能清单

**按模块查看**

- [工作台与日常导航](#feature-workspace)
- [AI 助手与可控的 Agent 工作流程](#feature-assistant)
- [AI 图片生成](#feature-drawing)
- [文字识别与校正](#feature-ocr)
- [音视频文件与实时语音转写](#feature-transcription)
- [文本、文件与媒体翻译](#feature-translation)
- [团队即时通信](#feature-messaging)
- [团队网盘与文件协作](#feature-drive)
- [兼容 AirPlay 的无线投屏](#feature-casting)
- [持久化虚拟 Android 手机](#feature-phones)
- [虚拟 Windows 与 Linux 电脑](#feature-computers)
- [管理、权限与安全](#feature-administration)
- [源码安装与维护](#feature-installation)
- [开源开发与扩展](#feature-developers)

<a id="feature-workspace"></a>

### 工作台与日常导航

- 在一台 DGX Spark 上，通过同一个浏览器工作空间使用本地 AI、团队协作和虚拟设备。
- 按分类浏览应用、搜索应用目录，并从侧栏打开应用。
- 分别查看各应用的加载进度、可用状态和服务详情。
- 在任务中心查看排队、运行、完成、失败和已取消的工作，并打开已生成的结果。
- 在通知菜单查看待处理的投屏邀请，并打开投屏应用作出回应。
- 选择 17 种界面语言，包括从右向左显示的阿拉伯语；未手动选择其他语言时默认英文。
- 选择浅色、深色或跟随系统的外观；刷新、重新登录和进入各应用后保留手动设置的语言与主题。

<a id="feature-assistant"></a>

### AI 助手与可控的 Agent 工作流程

- 发起对话、保存历史记录，并重新打开之前的讨论。
- 为当前请求选择自动、回答或 Agent 模式。
- 为请求添加多个文件附件，也可在发送前移除附件。
- 阅读流式回复、停止正在运行的任务，并在重新连接后继续接收事件。
- 查看返回的模型详情、工具活动、来源和用量；任务生成文件时可下载产物。
- 查看需要确认的 Agent 操作范围，单独批准或拒绝该操作。
- Agent 在每位用户独立的沙箱中工作，保留其工作空间；工具和网络访问遵循管理员策略。

<a id="feature-drawing"></a>

### AI 图片生成

- 使用可用的绘图模型，根据文字提示生成图片；当前应用不是图片编辑或局部重绘工具。
- 在可用模型配置支持时，选择自动或快速生成方式。
- 选择方形、横向或纵向比例、受支持的输出尺寸，以及随机或固定种子。
- 选择 PNG、WebP 或 JPEG 输出，预览并下载图片。
- 查看排队和生成进度、取消任务，并在重新打开页面后恢复当前任务。
- 查看结果记录的实际模型和生成参数。

<a id="feature-ocr"></a>

### 文字识别与校正

- 上传 PNG、JPEG、WebP 或 PDF，或从团队网盘选择已有文件。
- 提供语言提示，在所选模型支持的范围内识别文字、Markdown 表格或 LaTeX 公式。
- 按页面和文本块检查识别结果，并手动校正文字。
- 将校对后的内容导出为文本、Markdown 或 JSON。
- 把已保存的识别结果交给翻译应用，无须重新上传和识别原文件。
- 跟踪或取消识别任务。当前模型不提供文字框坐标或置信度分数。

<a id="feature-transcription"></a>

### 音视频文件与实时语音转写

- 选择本地或网盘中的音视频：WAV、FLAC、OGG、WebM、MP3、M4A、AIFF 或 MP4。
- 预览原始媒体，使用自动语言检测或受支持的语言提示。
- 查看带时间戳的转写片段，并编辑文字。
- 导出文本、JSON、SRT 或 WebVTT 字幕。
- 把已保存的转写结果交给翻译应用，并跟踪或取消当前转写任务。
- 在 HTTPS、浏览器权限、MediaRecorder 和实时服务均可用时，实时转写麦克风输入。
- 仅在支持的模型配置下使用词级时间戳或说话人分离；实验性的说话人分离流程需要 WAV 输入。

<a id="feature-translation"></a>

### 文本、文件与媒体翻译

- 从模型支持的 60 种语言目录中选择，自动检测源语言，或手动选择、交换源语言与目标语言；不承诺所有语言组合具有相同翻译质量。
- 翻译输入或粘贴的文字，对照查看原文和译文片段。
- 上传图片或 PDF，或从网盘选取；OCR 就绪时先识别其中的文字，再进行翻译。
- 转写服务就绪时，先转写再翻译受支持的音视频，并保留片段时间信息。
- 复用已保存的 OCR 或转写结果，并下载可用的中间结果。
- 编辑译文，导出文本、Markdown 或 JSON；音视频结果还支持 SRT 和 WebVTT。
- 查看提取、转写和翻译各阶段的进度，取消任务，并在重新打开页面后恢复当前任务。
- 翻译语种与界面、OCR、语音转写的语言范围不同。PDF 翻译以文字为主，不等于原版式重建或通用 DOCX/XLSX 编辑。

<a id="feature-messaging"></a>

### 团队即时通信

- 查找团队成员、发起单聊，或选择成员创建命名群聊。
- 筛选全部、未读或群聊，搜索自己有权访问的会话和消息。
- 发送文字和文件附件，下载附件的原始文件版本。
- 实时接收消息、断线后恢复历史记录、查看未读与已读位置，以及成员在线状态。
- 按 Enter 发送、Shift+Enter 换行；窄屏下可在会话列表和聊天页面之间切换。
- 从自己的视图删除单条消息，或清空自己的聊天记录；不会删除其他参与者的记录。
- 从自己的会话列表删除聊天，不会退出群组；新消息到来后，该会话可能重新出现。

<a id="feature-drive"></a>

### 团队网盘与文件协作

- 通过文件夹和路径导航组织个人及团队文件空间。
- 切换列表或网格视图、查看文件详情、搜索文件和文件夹，以及查看最近修改。
- 上传多个文件、查看上传进度或取消上传。
- 重新选择同一个大文件即可续传分块上传；已上传分块由服务端校验。
- 新建文件夹，对文件和文件夹重命名、移动或复制。
- 预览受支持的图片、音频、视频、文本和 PDF，并下载文件；媒体播放取决于浏览器支持。
- 上传文件新版本、查看版本历史，并下载旧版本。
- 将文件或文件夹移入回收站，并按需恢复。
- 向成员或团队进行内部分享，设置查看、编辑权限及可选的到期时间；不是匿名公网分享链接。
- 浏览他人分享的文件及文件夹，访问时重新核对当前权限和成员资格。

<a id="feature-casting"></a>

### 兼容 AirPlay 的无线投屏

- 为同一局域网内的兼容 Apple 设备开启或停止临时接收器，使用独立的接收器名称和 PIN。
- 选择 15、30、60 或 120 分钟的接收器有效期；停止或到期后结束广播和观看权限。
- 将观看范围设为仅自己、指定成员或团队；邀请观看者，由其接受或拒绝。
- 在浏览器中观看画面并播放声音；浏览器自动播放规则可能要求点击后才能启用声音。
- 查看并移除已连接的观看者；管理员可停止会话，但不会因此获得观看私人内容的权限。
- 查看断线和重连状态，重新加入时再次校验观看权限。
- 需要已就绪的媒体服务、可达的局域网发现和兼容浏览器及设备版本。浏览器观看不提供 HDMI 输出、DRM/FairPlay 播放或 Apple 认证。

<a id="feature-phones"></a>

### 持久化虚拟 Android 手机

- 使用已安装的系统配置创建独立 Android 手机，每台手机的应用和数据跨会话保留。
- 分别启动、关机、重启、重命名手机，或明确确认后删除手机。
- 通过键盘、指针以及返回、主页、最近应用和音量按钮操作 Android。
- 使用声音、全屏和重连功能，或把当前手机连接转移到另一页面。
- 向手机上传文件，并从手机的 Team AI Box 文件交换目录下载文件。
- 确认后安装自己提供的 APK；不会自动授予 Android 应用权限。
- 在支持时将图片、视频或浏览器摄像头输入虚拟摄像头；实体 USB 摄像头和网络输入还需要管理员配置及权限。
- 通过短时中继，临时授权针对指定设备的 ADB 调试，使用标准 ADB 工具和 Node.js 中继客户端。
- 按需查看帧率、丢包及连接往返时间统计；这些数值不是端到端画面延迟保证。
- 仅在相应资源可用时选择 Google Play 系统配置；可选用不等于通过 Play Protect 认证，也不保证所有 Android 应用兼容。

<a id="feature-computers"></a>

### 虚拟 Windows 与 Linux 电脑

- 创建独立的 ARM64 Windows/Linux 电脑，选择 CPU、内存和磁盘大小。
- 启动电脑、正常关机，并在明确确认后删除已停止的电脑。
- 在浏览器中打开虚拟显示器，查看固件、启动、安装及操作系统画面，无须先登录远程桌面。
- 使用键盘、指针、声音、全屏及重新连接功能。
- 在多个浏览器标签页或窗口中打开同一台虚拟电脑。
- 邀请团队成员观看或控制显示器，也可撤销其访问权限。
- 向其他参与者交接或释放控制权，主人可随时收回；可选择单人控制或共同控制模式。
- 上传安装 ISO，支持暂停、续传和取消；也可从个人或团队网盘选择已有 ISO。
- 挂载、弹出虚拟光盘，或设置下一次从光盘启动；更换光盘不会自动重启电脑。
- 自行安装已获授权的 ARM64 操作系统，并可另行使用远程桌面。Windows 许可由用户负责；不包含预激活 Windows，也不提供通用 x86 客体系统支持。

<a id="feature-administration"></a>

### 管理、权限与安全

- 创建本地成员、管理账户状态，并在角色允许的范围内重置密码。
- 分配内置角色、查看权限、管理团队成员，并对受保护的所有者操作施加额外防护。
- 按领域或关联 ID 筛选审计事件、查看详情，并发起审计历史完整性校验。
- 在管理工作台查看盒子、应用、存储及执行服务的状态。
- 配置外部 AI 提供方和模型、操作映射，轮换凭据，并启用或禁用提供方。
- 设置允许的本地或外部路由策略，外部处理需要明确批准；本地 AI 不要求外部 API Key。
- 查看已安装模型配置、运行版本、就绪状态和验证详情。
- 导入经过验证的插件包，对符合条件的插件进行安装、升级、启停或移除；受保护的官方插件另有限制。
- 查看执行队列和任务、调整允许修改的调度策略，并取消符合条件的任务。
- 查看加密存储和启动保护设置。自动解锁使用本机密钥；启用开机口令需完成恢复验证和确认。

<a id="feature-installation"></a>

### 源码安装与维护

- 在兼容的空白 DGX Spark 上，从公开 Git 仓库克隆后运行文档中的一条源码安装命令。
- 自动准备构建工具、下载模型和运行依赖、构建应用镜像、打包并安装，复用现有 Docker/NVIDIA 环境。
- 使用同一命令和工作目录恢复中断的准备流程，复用已校验下载及已完成步骤。
- 运行前置条件检查、仅下载准备，或仅构建安装包。
- 预先制作完整的可搬运安装包，在离线目标机上安装；源码准备本身仍需联网。
- 校验锁定的构建输入，必要时使用文档中的替代源或已验证的可搬运缓存；不保证任何第三方镜像站始终可用。
- 为新盒子生成独立凭据和文档规定的 admin/admin 初始账户，然后更改密码；不复制其他盒子的账户或客体系统磁盘。
- 查看维护候选、兼容性结果、明确的执行计划及历史，按范围提供回退和恢复说明；不是任意操作系统或驱动的自动升级。

<a id="feature-developers"></a>

### 开源开发与扩展

- 按 MIT 许可证阅读、修改和再分发自研产品代码及文档；第三方组件保留各自许可证。
- 使用公开 SDK 契约和随附示例，开发 ApplicationPlugin 或 ComputePlugin 扩展。
- 插件导入采用签名包清单、完整性和权限检查；不代表已提供公开插件市场。
- 通过 Issue 和 Pull Request 贡献修复、翻译、文档与集成；安全漏洞使用私密渠道报告。

## 什么是 NVIDIA DGX Spark？

NVIDIA DGX Spark 是采用 GB10 Grace Blackwell 超级芯片的小型桌面 AI 系统。128 GB 配置结合了 20 核 Arm CPU、Blackwell GPU 和 128 GB 统一系统内存，内存带宽为 273 GB/s。NVIDIA 标称的理论 AI 算力最高为 1 PFLOP，采用 FP4 精度与稀疏计算条件。

统一内存是共享系统内存，不是独立显存。参数因配置而异；理论算力不能当作应用实际速度或并发用户容量。

DGX Spark 提供计算能力，Team AI Box 提供团队共同使用本地推理、图像生成、文字识别、转写、翻译与协作工具的统一界面。首次源码安装需要下载依赖并构建运行环境。

[NVIDIA DGX Spark 官方硬件规格](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)

Team AI Box 是 Weerocks LLC 的独立项目，不是 NVIDIA 官方产品，也不表示获得 NVIDIA 认证或背书。本项目的硬件支持范围以下方安装要求为准。

<a id="install"></a>

## 在全新 DGX Spark 上安装

准备一台运行 **Ubuntu 24.04 ARM64 的全新 DGX Spark**，具备正常的 Docker Engine、Compose v2、NVIDIA 驱动及容器支持、KVM、Git 和 Python 3.10+。模型、容器构建与安装包需要数百 GB 临时空间。不要在已有业务数据上执行全新安装。

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

在 **Spark 本机**运行上述命令，不是在普通笔记本上运行。脚本下载模型和构建输入、构建运行镜像、生成完整离线包并安装。首次源码构建需要联网和较长下载、构建时间；clone 并不等于安装完成。复用现有 Docker 与 NVIDIA 环境。

### 预检、下载问题与断点续跑

`--check` 执行预检。中断后保留 `/var/tmp/teamaibox-source-build`，重跑**相同命令**，复用校验通过的下载与已完成阶段。不要并行启动重复构建或清空缓存。默认使用官方源；上游无法连接时，可按文档选择替代源，或从能联网的机器转移经校验的缓存/完整离线包，镜像站不保证可用。日志、`--cache-dir`、`--work-dir` 见[源码安装说明](install/SOURCE-INSTALL.zh-CN.md)。源码变化后使用新的工作目录，不绕过检查点。

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### 安装完成后

1. 使用 Spark 当前局域网地址打开 `https://<BOX_LAN_IP>/`，确认本机生成的 HTTPS 证书确实属于自己的设备。
2. 使用 `admin` / `admin` 登录，**立即修改初始密码**，再创建普通账户；不要将初始凭据暴露到公网。
3. 等待各 AI 应用分别就绪，在个人菜单选择语言与主题，从工作台开始。
4. 虚拟电脑由用户提供合法 Windows/Linux ARM64 ISO 与系统许可。离线目标需先取得完整安装包，再按[离线包说明](install/README.zh-CN.md)安装；源码准备本身不是离线过程。

## 开源范围与实际边界

自研代码和文档采用 MIT，**不是安装中的所有二进制都采用 MIT**。第三方代码、模型权重、NVIDIA 组件、固件、Google 服务和 Windows 保留各自条款。仓库不包含模型权重、已安装的 Android/Windows 磁盘、登录状态、ISO 或离线安装包。Google 兼容不等于 Play Protect 认证；投屏不包含 DRM 受保护内容或 Apple 认证；不宣称支持 Windows 10 ARM64。性能和并发取决于硬件与工作负载。

<a id="contribute"></a>

## 欢迎一起贡献

欢迎提交问题、文档、翻译、无障碍改进、应用集成和代码。先用 Issue 说明用户问题，再 fork、创建专注的分支并提交 PR，附相关检查和截图。文档和独立组件贡献不要求拥有 Spark；硬件验证要如实标注。不要上传密钥、个人文件或已登录的设备镜像。安全漏洞按 SECURITY.md 私下报告，不发公开 Issue；不要求强制 CLA 或付费贡献许可。

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.zh-CN.md) · [SECURITY](SECURITY.zh-CN.md)

## 进一步了解

- [源码安装、依赖与恢复](install/SOURCE-INSTALL.zh-CN.md)
- [离线包构建与安装](install/README.zh-CN.md)
- [开发环境与源码构建](docs/open-source/BUILDING.zh-CN.md)
- [贡献流程](CONTRIBUTING.zh-CN.md)
- [私密安全报告](SECURITY.zh-CN.md)
- [第三方许可与发行范围](THIRD_PARTY_NOTICES.zh-CN.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [第三方许可与发行范围](docs/open-source/RELEASING.zh-CN.md)
