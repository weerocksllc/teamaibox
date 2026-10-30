<!-- doc-navigation:start -->
[English](SOURCE-PRIVACY.md) · [简体中文](SOURCE-PRIVACY.zh-CN.md) · [繁體中文](SOURCE-PRIVACY.zh-TW.md) · [日本語](SOURCE-PRIVACY.ja.md) · [한국어](SOURCE-PRIVACY.ko.md) · [Français](SOURCE-PRIVACY.fr.md) · [Deutsch](SOURCE-PRIVACY.de.md) · [Español](SOURCE-PRIVACY.es.md) · [Português](SOURCE-PRIVACY.pt-BR.md) · [Русский](SOURCE-PRIVACY.ru.md) · [العربية](SOURCE-PRIVACY.ar.md) · [हिन्दी](SOURCE-PRIVACY.hi.md) · [Bahasa Indonesia](SOURCE-PRIVACY.id.md) · [Italiano](SOURCE-PRIVACY.it.md) · [Türkçe](SOURCE-PRIVACY.tr.md) · [Tiếng Việt](SOURCE-PRIVACY.vi.md) · [ไทย](SOURCE-PRIVACY.th.md)

[Team AI Box — README](../../README.zh-CN.md)
<!-- doc-navigation:end -->

# 公开源码隐私边界

公共产品存储库是新的源快照，而不是私有开发历史的镜像。营销网站有自己的私人存储库，此处不包括在内。

## 删除的材料

- 修复了部署测试帐户名称和密码以及个人帐户列表。
- 一台设备部署/恢复包装器和脚本，记录历史设备身份或来自私人证据的断言结果。
- 实际主机地址、主目录、容器/设备身份和历史维护快照。保留的测试使用明确的合成装置；维护的操作工具需要明确的目标输入。
- 访客磁盘、Android 登录状态、浏览器会话、安装包、模型权重和私人证据不在公共源分发范围内。

私人档案和原始交付标签保持完好。此源清理中不会更改设备帐户、来宾数据、正在运行的服务或网站部署。故意保留了`admin / admin`出厂默认值；它不是私人凭证。管理员必须在曝光之前对其进行更改。

## 审核和验证

查看工作树和正在发布的存储库中每个可访问的提交/标签。使用 Gitleaks 加上 `tools/open_source_sensitive.py`；两者都不足以证明低熵密码或个人元数据不存在。使用私有外部拒绝列表来比较已确认的旧私有值，而不是使用已提交的测试装置。单独审查剩余的结果，包括测试文件。

清理检查包括源策略、综合回归、配置和语法检查。他们不会使用发现的凭据登录、重新安装盒子或重复产品验收。早期的 API 打包更正（包括共享 UI 源和仅导入入口点检查）保留在源中。

新克隆不得导入已停用的提交、引用或标签。删除存储库不会召回其他人已经下载的副本。任何扫描都无法确定未知凭证从未被复制；实际使用的凭证必须由其操作员轮换。此清理并不声称已旋转它。

请参阅 [RELEASING.md](RELEASING.zh-CN.md) 了解源导出和审核说明，并参阅 [BUILDING.md](BUILDING.zh-CN.md) 了解构建先决条件和单独获取的资源。
