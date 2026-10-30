<!-- doc-navigation:start -->
[English](RELEASING.md) · [简体中文](RELEASING.zh-CN.md) · [繁體中文](RELEASING.zh-TW.md) · [日本語](RELEASING.ja.md) · [한국어](RELEASING.ko.md) · [Français](RELEASING.fr.md) · [Deutsch](RELEASING.de.md) · [Español](RELEASING.es.md) · [Português](RELEASING.pt-BR.md) · [Русский](RELEASING.ru.md) · [العربية](RELEASING.ar.md) · [हिन्दी](RELEASING.hi.md) · [Bahasa Indonesia](RELEASING.id.md) · [Italiano](RELEASING.it.md) · [Türkçe](RELEASING.tr.md) · [Tiếng Việt](RELEASING.vi.md) · [ไทย](RELEASING.th.md)

[Team AI Box — README](../../README.zh-TW.md)
<!-- doc-navigation:end -->

# 釋放邊界

## 單獨的工件

1. **MIT 候選來源**：原始程式碼、目前規格、經過審查的建置/測試工具和通知；沒有 Git 歷史記錄或私人實驗室證據。
2. **第三方材料**：具有自己的許可證和歸屬的確切上游原始碼/二進位檔案/模型。 Copyleft 來源義務隨二進位檔案一起傳遞。
3. **完整的離線設備包**：由`install/`建構；不會自動獲得公開重新分發的許可。 GMS、HunyuanOCR、NVIDIA 元件和訪客/韌體授權需要特定於工件的審核。請勿在 MIT 標籤下發布私有包、模型捆綁包或登入映像。
4. **行銷網站**：`website/`，包括其文章範本、內容、設計資產、分析和部署配置，保留在私人 `weerocksllc/teamaibox.com` GitHub 儲存庫中。 GitLab 是一個歷史檔案庫，而不是網站開發儲存庫。該網站不屬於公共產品來源分發的一部分。 `apps/` 中的裝置瀏覽器 UI 仍然是開源產品的一部分。

歷史單設備部署、復原和證據記錄腳本不是可重複使用的產品工具。發布策略不包括已退役的腳本和快照；不要從私人檔案中恢復它們。保留工具需要明確的操作員提供的目標，而不是開發人員的主機、帳戶、容器或證據文件。執行補充敏感掃描以及 Gitleaks：設備 ID、容器 ID、GSF 雜湊值和個人帳戶名稱正在測試元數據，即使它們不是可用的登入憑證。公共歷史記錄清理需要明確的所有者授權，並且絕不能重寫私人檔案或其交付標籤。授權重寫後，使用新的公共克隆，而不是將已退役的歷史記錄合併回維護的儲存庫中。

內部開發儲存庫及其標籤保持不變。其可達歷史記錄包含舊的部署記錄和已退役的專有 SDK 資產；不得以原樣公開。新鮮導出的樹提供了公共起點，而無需默默地重寫原始交付歷史。

## 本地準備

使用從官方 GitHub 版本下載的 **Gitleaks 8.30.1** 並驗證其校驗和。審計工具從不安裝系統包或上傳資料。私人輸出會被忽略 `.runtime/open-source-audit/`，而不是公共 PR。

```sh
python3 tools/open_source_release.py baseline --output .runtime/open-source-audit/before.json
python3 tools/open_source_release.py scan --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/review
python3 tools/open_source_sensitive.py --output .runtime/open-source-audit/project-review.json
python3 tools/open_source_inventory.py
python3 tools/open_source_release.py export --gitleaks /path/to/gitleaks --output .runtime/open-source-audit/source-candidate
```

輸出必須是新路徑；這些工具永遠不會覆蓋先前的候選者。檢查已編輯的位置，不僅僅是重要的。分別記錄合成裝置、公共引導憑證、識別碼誤報和實際/可能的私人憑證。模式掃描無法驗證憑證或 OCR 螢幕截圖。二進制工件被排除，未聲明掃描乾淨。來源導出器僅接受 [release-policy.json](release-policy.json) 中的 Git 已知檔案和明確未追蹤輸入。新的未追蹤輸入需要審查。它拒絕符號連結和路徑遍歷，並發出每個檔案的 SHA-256 以及排除項。 `website/` 始終被排除，即使已追蹤或列為未追蹤輸入。切勿將私人儲存庫的 `.git` 目錄複製到公用結帳。在發布之前，驗證樹和所有可存取的公共提交不包含網站文件；在以後的提交中刪除文件不會刪除舊的歷史記錄。

補充檢查包括可到達的提交/標籤訊息、低熵憑證和登入文字、裝置身分和開發地址。測試不會自動免除：解釋為什麼每個保留的夾具都是合成的。已知的私有值可以透過 `--denylist` 作為 `{id, value, word?}` 記錄的外部 JSON 陣列提供。使用不透明、不敏感的 ID；將此文件保留在來源簽出之外。報告顯示位置和雜湊值，而不是值。已知標記匹配會使檢查失敗。清潔時使用`--scope worktree`；在發布之前檢查新的無父版本存儲庫中的 `--scope all`。不要發表舊曆史或私人評論報告。

唯一有意的工廠管理員預設值是 `admin / admin`；在部署期間更改它。部署/瀏覽器測試工具必須透過受保護的本機輸入接收現有帳戶憑證。新建立的冒煙測試帳戶使用隨機憑證，並在清理過程中被停用。失敗的清理是測試失敗，而不是成功的運行。進程突然終止會阻止清理工作；運營商必須在此類中斷後核對其臨時帳戶。目前沒有公開文件聲稱測試證書有效。

只有維護的 `install/` 入口點才是乾淨設備安裝路徑。組件所有權評估位於 [OWNERSHIP.md](OWNERSHIP.zh-TW.md) 中。

這裡沒有命令推送 Git、更改可見性、重寫歷史記錄、輪換即時憑證、更改設備或授予第三方重新分發權限。公開發布需要明確選擇的公共目的地和最終工件審查。將 `delivery-2026-10-22` 保留在私人儲存庫中。
