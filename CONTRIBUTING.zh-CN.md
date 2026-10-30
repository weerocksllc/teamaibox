<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.zh-CN.md)
<!-- doc-navigation:end -->

# 贡献

感谢您帮助改进 Team AI Box。我们欢迎首次贡献者：错误报告、翻译、文档、可访问性、应用程序集成和重点代码更改都很重要。您不需要 DGX Spark 来改进可以独立检查的文档或组件。

## 从想法到拉取请求

1. 搜索[现有问题](https://github.com/weerocksllc/teamaibox/issues)。描述用户问题、预期行为、实际行为和相关版本。在投资实施之前讨论更大的变化。
2. 分叉公共存储库并克隆您的分叉。创建一个重点分支；不包括私人营销网站、运行时数据或下载的模型。
3. 按照 [BUILDING](docs/open-source/BUILDING.zh-CN.md) 进行 Node、pnpm 和本地组件构建。新设备安装程序是一个不同的工作流程：切勿仅为了开发 UI 而在包含业务数据的计算机上运行它。
4. 进行最小的一致更改，更新受影响的文档并运行相关检查。解释您无法运行的任何与硬件相关的检查。
5. 打开一个拉取请求，描述问题、解决方案、兼容性影响和检查。包括经过清理的屏幕截图以显示可见的更改。回复审核反馈；维护者在合并之前进行审查。

本地 OpenSpec 工作区是可选的，不会在此存储库中发布。公共贡献者可以直接在问题或 PR 中提出提案和接受标准；参与时不需要缺少任何私人规范。

## 翻译和截图

所有 17 种产品语言都有自述文件。编辑 `docs/readme-locales/<locale>.json`，然后运行 ​​`node tools/render-readmes.mjs` 和 `node tools/render-readmes.mjs --check`。不要手动编辑生成的自述文件。区域设置列表来自 `packages/ui-system/src/locale-registry.mjs`。链接的安装、构建、贡献、安全和许可指南使用相同的 17 种语言。他们的文档列表位于 `docs/document-locales/manifest.json`。在 `docs/document-locales/<locale>.json` 中编辑源语言页面和段落翻译，然后运行 ​​`node tools/render-documents.mjs`、`node tools/render-readmes.mjs` 和 `node tools/check-document-locales.mjs`。翻译密钥是源段落的 SHA-256 哈希值；源更改会使渲染器失败，直到更新相应的翻译。代码示例逐字共享，并为所选语言生成文档链接。新翻译是带有受保护代码和链接的机器辅助草稿；欢迎语言和术语审查。生成和检查在本地运行，无需翻译服务、API 密钥或访问设备。添加公共图片之前请参阅[屏幕截图政策](docs/assets/screenshots/README.zh-CN.md)。欢迎评论贡献翻译，包括术语和自然措辞。

## 贡献规则

- 原始贡献是根据存储库的 MIT 许可证提交的。保留第三方标题并说明复制材料的来源/许可证。不需要单独的强制性 CLA 或付费贡献者许可。
- 使用 Node 24 和固定在 `package.json` 中的 pnpm 版本。 Python 和 Go 要求在 [BUILDING](docs/open-source/BUILDING.zh-CN.md) 中描述。
- 仅运行与您的更改相关的测试并准确报告运行的内容。本地固定装置并不代表真实设备已被接受。不要仅仅为了结束文档更改而重复或删除历史验收结果。
- 切勿针对用户数据测试删除、重新安装或恢复。使用合成装置或明确指定的临时资源。
- 问题/PR 中没有私钥、令牌、cookie、客户提示/文件、登录的访客图像、私人部署快照或个人屏幕截图。请参阅 [安全](SECURITY.zh-CN.md) 了解私人报告。
- 将 `private: true` 保留在工作区包中。切勿重写共享的 Git 历史记录、移动交付标签或将私有构建工件作为 PR 的一部分发布。

在您的贡献中记录相关测试、迁移和行为变化。与硬件相关的检查必须确定实际配置和限制。
