<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.zh-CN.md)
<!-- doc-navigation:end -->

# 构建源代码

公共工件是源，而不是预构建的离线设备映像。源构建可以下载依赖项；使用准备好的完整包进行安装仍处于脱机状态。这两个过程都不​​需要 ViKey SDK 或 USB 密钥。

对于完整的设备安装，请从根[快速启动](../../README.zh-CN.md#install)和[源安装程序](../../install/SOURCE-INSTALL.zh-CN.md)开始：`sudo bash install/from-source.sh`在兼容的全新 Spark 上下载、构建、打包和安装。下面的开发 Web 构建不是安装程序，也不会启动完整的产品。

## 发展

使用 Node.js 24、pnpm 11.1.3（请参阅根 `package.json`）、Python 3.10+ 以及每个 `go.mod` 中声明的 Go 版本（节点代理当前为 1.26）。在构建机器上：

源导出故意没有私有 Git 历史记录。在导出的树上运行源工具之前，请初始化您自己的存储库并提交您审阅的树（`git init`、`git add .`、`git commit`）。普通的公共 Git 克隆不需要此步骤。使用新的提交作为构建标识；不要声称导出的、修改的树是旧的交付提交。

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

Web 构建是编译检查，而不是产品验收。运行时服务使用 `deploy/` 下的 Dockerfile。 DGX Spark 执行需要 Linux ARM64 和现有的 NVIDIA/Docker 环境。桌面源签出并不能替代该硬件。不要使用历史实验室脚本作为安装程序。

Python 工厂构建助手还需要 PyYAML；请参阅安装程序依赖项预检。无需安装操作系统磁盘或开发人员帐户。

## 排除编译输入

导出器会忽略二进制文件，即使它们的扩展名看起来无害：

- 从 Go 源代码构建 `services/node-agent` 及其 `cmd/factory-worker-spec` 助手；存储库根 `node-agent` 可执行文件不是源输入。
- 不提供 Android 固定 APK 和签名文件。它们在 `tools/fixtures/` 下的源和清单仍然可用于本地测试版本。
- 当前的设备铸造版本使用 `deploy/appliance/wireless-casting-plugin.Dockerfile`。它不需要旧的 Alpine 包档案。如果您使用独立插件 Dockerfile，请获取[其上游校验和清单](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json) 中标识的确切包，并在构建之前验证其 SHA-256 值。当固定的上游工件不可用时，切勿替换任意包。
- LiveKit浏览器模块及其许可证保留在插件的公共源目录中；冗余的 npm `.tgz` 存档未提供。

这些是源分发排除，而不是对正在运行的设备的更改。

## 完整的离线包

从[公共源管道](../../install/PUBLIC-BUILD.zh-CN.md)开始。它提供公共父映像和源构建的运行时依赖项；不需要以前的开发人员安装。历史分层镜像构建步骤不是全新安装的入口点。

按照 [install/README.md](../../install/README.zh-CN.md) 进行应用程序映像构建、来宾主机工具、离线主机包、资产收集和最终打包。目标设备不会获取依赖项或替换 Docker/NVIDIA。将构建输入设置为实际源代码提交、ARM64 OCI 内容 ID 和干净的资产路径。不需要开发主机 IP、帐户、证书或卷。模型权重和来宾/运行时资产是从 [components.json](components.json) 中标识的确切上游源和存储库锁中单独获取的。保留他们的许可证和所需的来源声明。

**源可用性不是二进制重新分发许可。** 当前完整的离线包合同包括 Google Android 运行时；其私人安装证据是不允许分发GMS。现有的打包程序保持不变，但除非获得这些权利，否则此类软件包不是经过批准的公开下载。仅 AOSP 的公共二进制版本将是单独范围的包装更改，而不是在这里默默地替换。 Windows/Linux ISO文件由每个用户提供；没有安装的测试来宾或帐户状态是公共构建输入。
