<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.zh-CN.md)
<!-- doc-navigation:end -->

# ARM 虚拟计算机运行时

`Public.Dockerfile` 构建了原始 `windows-arm64-ppi` 运行时所需的相同 ARM TPM 物理存在 (PPI) 功能。在根据固定的发布管理器指纹验证其分离签名后，它从官方版本构建 QEMU 11.1.1。 Debian 提供容器库和工具，而不是用于运行 guest 虚拟机的 QEMU 可执行文件。

不要用较旧的 QEMU 分发包替换此可执行文件。 Windows 配置文件启用 `tpm-tis-device,...,ppi=on`；没有该 ARM 属性的构建会在固件启动之前退出。删除 `ppi=on`、禁用 TPM 或重置来宾的 TPM 不属于兼容修复。

最终的映像构建检查 ARM TIS PPI 和 PulseAudio 支持并包括匹配的 RAM 帧缓冲 ROM。在 ARM KVM 主机上，捆绑的 `python3 /usr/local/bin/probe-ppi` 执行无盘、暂停的 QEMU/TPM 检查。它不会安装现有的来宾磁盘或证明 Windows 安装已完成。必须在明确指定的测试来宾上单独检查 Windows 启动。

对于现有安装，请使用平台的运行时更新策略和匹配的节点代理配置文件映像摘要。保留磁盘、固件、TPM 身份和状态。不要仅仅为了修复 Windows 运行时而重新创建来宾或更改正在运行的 Linux 来宾映像。将本地构建的镜像记录为未发布，直到提交并发布其源更改。

更新时保留已安装配置的所有权和读取权限。如果重新创建 Platform API 以加载运行时更新策略，则还要从未更改的映像重新创建其网络命名空间依赖项（`node-agent`、`appliance-gateway`、`desktop-proxy`、`desktop-gateway` 和 `maintenance-controller`）。它们必须加入新 API 容器的网络命名空间。这不是来宾、Docker 守护进程或 AI 工作线程重启。在提交 Windows 启动操作之前，等待节点的正常身份验证心跳恢复就绪状态。
