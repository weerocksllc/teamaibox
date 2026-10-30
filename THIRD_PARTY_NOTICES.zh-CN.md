<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.zh-CN.md)
<!-- doc-navigation:end -->

# 许可范围和第三方声明

版权所有 © 2026 Weerocks LLC。根 [MIT 许可证](LICENSE) 涵盖其所有者授权的原始 Team AI Box 代码和文档。它不会重新许可第三方代码、复制/修改的上游文件、依赖项、模型、固件、操作系统、字体或图像。现有的版权、许可证和通知文件对于各自的材料具有优先权。包元数据 `license: MIT` 指的是该包的原始代码，而不是已部署映像中包含的所有内容。保留 `private: true` 以避免意外的包注册表发布；它不会撤销 MIT 授予。

## 库存

机器可读的[组件清单](docs/open-source/components.json)记录版本或版本来源、许可证据、再分发范围和未解决的二进制义务。 [依赖项清单](docs/open-source/dependencies.json) 是根据锁定文件、已安装的依赖项元数据、​​Go 模块和 Python 需求文件生成的。缺少的许可证元数据是明确未知的，不假设 MIT。使用 `python3 tools/open_source_inventory.py` 重新生成它。

|组件/材料|许可边界|分销要求|
| ---| ---| ---|
| UxPlay 接收器和 `deploy/casting/uxplay-*.patch` | GPL-3.0-only |保留 GPL、通知、准确的上游源代码、补丁以及使用任何接收器二进制文件构建脚本；对于二进制版本来说，仅仅链接到上游是不够的。 |
| gst-插件-rs / `gst-webrtc-*.patch` | MPL-2.0 |保留通知并提供修改后的涵盖源文件。 |
| GStreamer | LGPL 和个人插件许可证 |检查实际插件集并履行相应义务。 |
| LiveKit服务器/浏览器SDK | Apache-2.0 |保留版权、许可和适用的声明。 |
|墨鱼/ AOSP | Apache-2.0 和每个文件许可证，包括 GPL 内核 |保留上游通知和适用的相应来源。 AOSP 不包含 Google 服务许可。 |
| QEMU / Linux / EDK II / virtio 驱动程序 |每个项目和每个文件的许可证 |审核实际的二进制构建、固件和驱动程序；不要一揽子标签MIT。 |
|鳄梨酱| Apache-2.0 |保留计算机插件 Dockerfile 复制的许可证和通知。 |
| Node/React/Vite 与 JS 依赖树 |每包许可证 |分发捆绑输出时保留依赖性通知。 |
| PostgreSQL 和容器操作系统包 | PostgreSQL / 每个包 |在二进制版本中包含已安装的软件包许可证记录。 |
| OCR 使用的 PyMuPDF / MuPDF | AGPL-3.0-or-later 或商业许可 |组合的 OCR 工作人员分配/服务不是一揽子 MIT；遵守 AGPL 义务或获得商业权利。原始代码可能会保留其 MIT 授权。 |
| Qwen / LMT / Whisper / FLUX 模型资产 |精确模型的条款 |模型与 MIT 来源授权是分开的。 FLUX **4B** 术语不得替代其他 FLUX 模型。 |
|混元OCR权重|腾讯混元社区授权|有条件型号许可证；检查每个版本的接收者、地区、使用、归属和再分发条款。 |
| NVIDIA 软件 | NVIDIA 和包含的第三方条款 |现有主机 Docker/NVIDIA 安装不会由此源包重新分发。捆绑的 CUDA/容器库仍然需要自己的审查。 |
|谷歌移动服务/Play商店|专有|不属于公共源候选者的一部分。运行时集成代码不授予分发 GMS 映像的权限。 |
| Windows 安装介质、来宾磁盘、帐户 |未涵盖 |用户提供授权的 ISO 介质和许可证。切勿运送测试虚拟机磁盘或登录的来宾状态。 |
|退役的 ViKey SDK |专有/未设立公共资助 | SDK 从工作源中删除；不得发布私有历史提交和保留的 SDK 副本。不需要 USB 密钥。 |

确切的选角通知保留在 [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt) 中。 ADB 运输通知保留在电话客户端旁边。缩小或包装时请勿移除它们。容器隔离本身并不能取消 Copyleft 义务。分布分析取决于实际的组合工件。

## 品牌和贡献者

MIT 授予版权许可，而不是商标权或认可。 Team AI Box 和 Weerocks 名称/徽标不得暗示对修改产品的官方支持。 NVIDIA、DGX Spark、Android、Google Play、Windows 和 Apple/AirPlay 属于其各自所有者。兼容性不是认证。

本地作者元数据是一份清单，而不是版权转让的证明。审核的所有权类别记录在 [OWNERSHIP.md](docs/open-source/OWNERSHIP.zh-CN.md) 中。项目业主的授权适用于其原始出资；贡献者必须仅提交他们有权获得许可的作品。疑似缺少归属：teamaibox@weerocks.llc。
