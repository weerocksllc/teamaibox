<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.zh-TW.md)
<!-- doc-navigation:end -->

# 貢獻

感謝您協助改進 Team AI Box。我們歡迎首次貢獻者：錯誤報告、翻譯、文件、可訪問性、應用程式整合和重點程式碼變更都很重要。您不需要 DGX Spark 來改進可以獨立檢查的文件或元件。

## 從想法到拉取請求

1. 搜尋[現有問題](https://github.com/weerocksllc/teamaibox/issues)。描述使用者問題、預期行為、實際行為和相關版本。在投資實施之前討論更大的變化。
2. 分叉公共儲存庫並克隆您的分叉。建立一個重點分支；不包括私人行銷網站、運行時資料或下載的模型。
3. 依照 [BUILDING](docs/open-source/BUILDING.zh-TW.md) 進行 Node、pnpm 和本機元件建置。新設備安裝程式是一個不同的工作流程：切勿僅為了開發 UI 而在包含業務資料的電腦上運行它。
4. 進行最小的一致更改，更新受影響的文件並執行相關檢查。解釋您無法運行的任何與硬體相關的檢查。
5. 開啟一個拉取請求，描述問題、解決方案、相容性影響和檢查。包括經過清理的螢幕截圖以顯示可見的變更。回覆審核回饋；維護者在合併之前進行審查。

本機 OpenSpec 工作區是可選的，不會在此儲存庫中發布。公共貢獻者可以直接在問題或 PR 中提出提案和接受標準；參與時不需要缺少任何私人規範。

## 翻譯與截圖

所有 17 種產品語言都有自述文件。編輯 `docs/readme-locales/<locale>.json`，然後執行 `node tools/render-readmes.mjs` and `node tools/render-readmes.mjs --check`。不要手動編輯產生的自述文件。區域設定清單來自 `packages/ui-system/src/locale-registry.mjs`。連結的安裝、建置、貢獻、安全性和許可指南使用相同的 17 種語言。他們的文檔清單位於 `docs/document-locales/manifest.json`。在 `docs/document-locales/<locale>.json` 中編輯原始語言頁面和段落翻譯，然後執行 `node tools/render-documents.mjs`, `node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs`。翻譯金鑰是來源段落的 SHA-256 雜湊值；來源變更會使渲染器失敗，直到更新對應的翻譯。程式碼範例逐字共享，並為所選語言產生文件連結。新翻譯是帶有受保護代碼和連結的機器輔助草稿；歡迎語言和術語審查。產生和檢查在本地運行，無需翻譯服務、API 金鑰或存取設備。在新增公開圖片之前，請參閱[螢幕截圖政策](docs/assets/screenshots/README.zh-TW.md)。歡迎評論貢獻翻譯，包括術語和自然措辭。

## 貢獻規則

- 原始貢獻是根據儲存庫的 MIT 許可證提交的。保留第三方標題並說明複製材料的來源/許可證。不需要單獨的強制性 CLA 或付費貢獻者許可。
- 使用 Node 24 和固定在 `package.json` 中的 pnpm 版本。 Python 和 Go 要求在 [BUILDING](docs/open-source/BUILDING.zh-TW.md) 中描述。
- 僅執行與您的變更相關的測試並準確報告運行的內容。本地固定裝置並不代表真實設備已被接受。不要僅僅為了結束文件變更而重複或刪除歷史驗收結果。
- 切勿針對使用者資料測試刪除、重新安裝或復原。使用合成裝置或明確指定的臨時資源。
- 問題/PR 中沒有私鑰、令牌、cookie、客戶提示/檔案、登入的訪客影像、私人部署快照或個人螢幕截圖。請參閱 [安全性](SECURITY.zh-TW.md) 以了解私人報告。
- 將 `private: true` 保留在工作區包中。切勿重寫共享的 Git 歷史記錄、移動交付標籤或將私有建置工件作為 PR 的一部分發布。

在您的貢獻中記錄相關測試、遷移和行為變化。與硬體相關的檢查必須確定實際配置和限制。
