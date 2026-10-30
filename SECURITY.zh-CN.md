<!-- doc-navigation:start -->
[English](SECURITY.md) · [简体中文](SECURITY.zh-CN.md) · [繁體中文](SECURITY.zh-TW.md) · [日本語](SECURITY.ja.md) · [한국어](SECURITY.ko.md) · [Français](SECURITY.fr.md) · [Deutsch](SECURITY.de.md) · [Español](SECURITY.es.md) · [Português](SECURITY.pt-BR.md) · [Русский](SECURITY.ru.md) · [العربية](SECURITY.ar.md) · [हिन्दी](SECURITY.hi.md) · [Bahasa Indonesia](SECURITY.id.md) · [Italiano](SECURITY.it.md) · [Türkçe](SECURITY.tr.md) · [Tiếng Việt](SECURITY.vi.md) · [ไทย](SECURITY.th.md)

[Team AI Box — README](README.zh-CN.md)
<!-- doc-navigation:end -->

# 安全报告

请私下向 **teamaibox@weerocks.llc** 报告可疑漏洞。包括受影响的版本、最小复制、影响和编辑日志。请勿将凭据、客户内容或利用细节放在公共问题中。在发送敏感文件之前请求适当的安全传输通道。没有声称响应时间保证或独立安全认证。

新的离线安装当前使用记录的引导管理器 `admin` / `admin`；在将设备暴露给用户或不受信任的网络之前更改该密码。这是一个公开的初始凭证，而不是隐藏在扫描仪白名单中的秘密。不会自动创建普通用户帐户。更改此入职行为不属于此许可变更范围。

## 来源/历史回顾

有关排除的数据、历史记录审查和凭证轮换责任，请参阅[公共来源隐私边界](docs/open-source/SOURCE-PRIVACY.zh-CN.md)。

按照[发布准备](docs/open-source/RELEASING.zh-CN.md)中的说明运行固定的本地扫描仪。报告是私密的、经过编辑的，并且绝不会上传到外部扫描服务。如果真实凭证出现在私人历史记录中，则从 HEAD 中删除并不意味着撤销。与所有者一起撤销/轮换它；重写或删除历史记录需要单独授权。原始交货标签不会被移动以进行消毒。

公共源候选者是不包含 `.git`、私人证据、设备快照、访客数据或受限二进制文件的新文件导出。 **不要**简单地更改此开发存储库的可见性或公开推送其旧引用。
