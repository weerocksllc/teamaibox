<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../../README.zh-CN.md)
<!-- doc-navigation:end -->

# 公开产品截图

这些是真实的 Team AI Box 工作台捕获的图像，17 个 UI 区域设置中的每一个区域都有一张浅色图像和一张深色图像。它们是产品文档资产，而不是私人营销网站的源代码、模板或构建输出。

## 捕获规则

- 使用实际的产品语言和主题控件；不要将标签翻译成英文屏幕截图或发明成功的结果。
- 使用演示帐户并检查每张图像中的个人消息、文件名、凭据、接收者 PIN、网络地址和浏览器镶边。切勿发布带有图像的登录来宾磁盘或会话/cookie 导出。
- 当前工作台捕获仅显示通用演示任务状态和通用管理员帐户。它们不公开任务负载。
- 捕获后保持产品设置不变。请勿删除用户数据或重新运行业务工作负载来获取屏幕截图。
- `workbench-light.jpg` 和 `workbench-dark.jpg` 是原件。大多数使用全页捕获。阿拉伯语使用实际视口，因为浏览器的全页 RTL 捕获取代了页面；没有改变标签或结果。
- 一些实时任务状态单词在其他本地化视图中仍然是英语。这些图像有意保留已发布的 UI，而不是对其进行修饰。来宾操作系统、模型响应和用户定义的名称具有单独的语言设置，并且不会由 UI 选择器进行翻译。

自述文件渲染器需要每个产品区域设置的两个图像，并且会失败，而不是默默地退回到英文屏幕截图。刷新 UI 时，替换两个主题并使用 `node tools/screenshot-manifest.mjs` 重新生成图像清单。将网络/设备标识符和本地捕获日志保留在此公共目录之外。
