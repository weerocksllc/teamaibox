<!-- doc-navigation:start -->
[English](RELEASING.md) · [简体中文](RELEASING.zh-CN.md) · [繁體中文](RELEASING.zh-TW.md) · [日本語](RELEASING.ja.md) · [한국어](RELEASING.ko.md) · [Français](RELEASING.fr.md) · [Deutsch](RELEASING.de.md) · [Español](RELEASING.es.md) · [Português](RELEASING.pt-BR.md) · [Русский](RELEASING.ru.md) · [العربية](RELEASING.ar.md) · [हिन्दी](RELEASING.hi.md) · [Bahasa Indonesia](RELEASING.id.md) · [Italiano](RELEASING.it.md) · [Türkçe](RELEASING.tr.md) · [Tiếng Việt](RELEASING.vi.md) · [ไทย](RELEASING.th.md)

[Team AI Box — README](../../README.zh-CN.md)
<!-- doc-navigation:end -->

# 释放边界

## 单独的工件

1. **MIT 候选源**：原始代码、当前规范、经过审查的构建/测试工具和通知；没有 Git 历史记录或私人实验室证据。
2. **第三方材料**：具有自己的许可证和归属的确切上游源代码/二进制文件/模型。 Copyleft 源义务随二进制文件一起传递。
3. **完整的离线设备包**：由`install/`构建；不会自动获得公开重新分发的许可。 GMS、HunyuanOCR、NVIDIA 组件和访客/固件许可证需要特定工件的审查。请勿在 MIT 标签下发布私有包、模型捆绑包或登录图像。
4. **营销网站**：`website/`，包括其文章模板、内容、设计资产、分析和部署配置，保留在私有 `weerocksllc/teamaibox.com` GitHub 存储库中。 GitLab 是一个历史档案库，而不是网站开发存储库。该网站不属于公共产品源分发的一部分。 `apps/` 中的设备浏览器 UI 仍然是开源产品的一部分。

历史单设备部署、恢复和证据记录脚本不是可重用的产品工具。发布策略不包括已退役的脚本和快照；不要从私人档案中恢复它们。保留工具需要明确的操作员提供的目标，而不是开发人员的主机、帐户、容器或证据文件。运行补充敏感扫描以及 Gitleaks：设备 ID、容器 ID、GSF 哈希值和个人帐户名称正在测试元数据，即使它们不是可用的登录凭据。公共历史记录清理需要明确的所有者授权，并且绝不能重写私人档案或其交付标签。授权重写后，使用新的公共克隆，而不是将已退役的历史记录合并回维护的存储库中。

内部开发存储库及其标签保持不变。其可达历史记录包含旧的部署记录和已退役的专有 SDK 资产；不得原样公开。新鲜导出的树提供了公共起点，而无需默默地重写原始交付历史。

## 本地准备

使用从官方 GitHub 版本下载的 **Gitleaks 8.30.1** 并验证其校验和。审计工具从不安装系统包或上传数据。私人输出会被忽略 `.runtime/open-source-audit/`，而不是公共 PR。

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

输出必须是新路径；这些工具永远不会覆盖以前的候选者。检查已编辑的位置，不仅仅是重要的。分别记录合成装置、公共引导凭证、标识符误报和实际/可能的私人凭证。模式扫描无法验证凭据或 OCR 屏幕截图。二进制工件被排除，未声明扫描干净。源导出器仅接受 [release-policy.json](release-policy.json) 中的 Git 已知文件和显式未跟踪输入。新的未跟踪输入需要审查。它拒绝符号链接和路径遍历，并发出每个文件的 SHA-256 以及排除项。 `website/` 始终被排除，即使已跟踪或列为未跟踪输入。切勿将私有存储库的 `.git` 目录复制到公共结账中。在发布之前，验证树和所有可访问的公共提交不包含网站文件；在以后的提交中删除文件不会删除旧的历史记录。

补充检查包括可到达的提交/标签消息、低熵凭证和登录文字、设备身份和开发地址。测试不会自动免除：解释为什么每个保留的夹具都是合成的。已知的私有值可以通过 `--denylist` 作为 `{id, value, word?}` 记录的外部 JSON 数组提供。使用不透明、不敏感的 ID；将此文件保留在源签出之外。报告显示位置和哈希值，而不是值。已知标记匹配会使检查失败。清洁时使用`--scope worktree`；在发布之前检查新的无父版本存储库中的 `--scope all`。不要发表旧历史或私人评论报告。

唯一有意的工厂管理员默认值是 `admin / admin`；在部署期间更改它。部署/浏览器测试工具必须通过受保护的本地输入接收现有帐户凭据。新创建的冒烟测试帐户使用随机凭据，并在清理过程中被禁用。失败的清理是测试失败，而不是成功的运行。进程突然终止会阻止清理工作；运营商必须在此类中断后核对其临时账户。目前没有公开文件声称测试证书有效。

只有维护的 `install/` 入口点才是干净设备安装路径。组件所有权评估位于 [OWNERSHIP.md](OWNERSHIP.zh-CN.md) 中。

这里没有命令推送 Git、更改可见性、重写历史记录、轮换实时凭据、更改设备或授予第三方重新分发权限。公开发布需要明确选择的公共目的地和最终工件审查。将 `delivery-2026-10-22` 保留在私有存储库中。
