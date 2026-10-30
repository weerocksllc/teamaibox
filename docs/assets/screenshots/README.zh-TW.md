<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../../README.zh-TW.md)
<!-- doc-navigation:end -->

# 公開產品截圖

這些是真實的 Team AI Box 工作台捕獲的圖像，17 個 UI 區域設定中的每一個區域都有一張淺色圖像和一張深色圖像。它們是產品文檔資產，而不是私人行銷網站的源代碼、範本或建置輸出。

## 捕獲規則

- 使用實際的產品語言和主題控制；不要將標籤翻譯成英文螢幕截圖或發明成功的結果。
- 使用演示帳戶並檢查每張圖像中的個人訊息、檔案名稱、憑證、接收者 PIN、網頁位址和瀏覽器鑲邊。切勿發布帶有影像的登入來賓磁碟或會話/cookie 匯出。
- 目前工作台擷取僅顯示通用演示任務狀態和通用管理員帳戶。它們不公開任務負載。
- 捕獲後保持產品設定不變。請勿刪除使用者資料或重新執行業務工作負載來取得螢幕截圖。
- `workbench-light.jpg` and `workbench-dark.jpg` 是原件。大多數使用全頁捕獲。阿拉伯語使用實際視口，因為瀏覽器的全頁 RTL 擷取取代了頁面；沒有改變標籤或結果。
- 一些即時任務狀態單字在其他本地化視圖中仍然是英文。這些圖像有意保留已發布的 UI，而不是對其進行修飾。來賓作業系統、模型回應和使用者定義的名稱具有單獨的語言設置，並且不會由 UI 選擇器進行翻譯。

自述文件渲染器需要每個產品區域設定的兩個圖像，並且會失敗，而不是默默地退回到英文螢幕截圖。刷新 UI 時，請取代兩個主題並使用 `node tools/screenshot-manifest.mjs` 重新產生圖像清單。將網路/裝置識別碼和本機擷取日誌保留在此公共目錄之外。
