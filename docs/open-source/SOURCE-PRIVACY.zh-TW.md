<!-- doc-navigation:start -->
[English](SOURCE-PRIVACY.md) · [简体中文](SOURCE-PRIVACY.zh-CN.md) · [繁體中文](SOURCE-PRIVACY.zh-TW.md) · [日本語](SOURCE-PRIVACY.ja.md) · [한국어](SOURCE-PRIVACY.ko.md) · [Français](SOURCE-PRIVACY.fr.md) · [Deutsch](SOURCE-PRIVACY.de.md) · [Español](SOURCE-PRIVACY.es.md) · [Português](SOURCE-PRIVACY.pt-BR.md) · [Русский](SOURCE-PRIVACY.ru.md) · [العربية](SOURCE-PRIVACY.ar.md) · [हिन्दी](SOURCE-PRIVACY.hi.md) · [Bahasa Indonesia](SOURCE-PRIVACY.id.md) · [Italiano](SOURCE-PRIVACY.it.md) · [Türkçe](SOURCE-PRIVACY.tr.md) · [Tiếng Việt](SOURCE-PRIVACY.vi.md) · [ไทย](SOURCE-PRIVACY.th.md)

[Team AI Box — README](../../README.zh-TW.md)
<!-- doc-navigation:end -->

# 公開源碼隱私邊界

公共產品儲存庫是新的來源快照，而不是私有開發歷史的鏡像。行銷網站有自己的私人儲存庫，此處不包括在內。

## 刪除的材料

- 修復了部署測試帳戶名稱和密碼以及個人帳戶清單。
- 一台設備部署/恢復包裝器和腳本，記錄歷史設備身分或來自私人證據的斷言結果。
- 實際主機位址、主目錄、容器/裝置身分和歷史維護快照。保留的測試使用明確的合成裝置；維護的操作工具需要明確的目標輸入。
- 訪客磁碟、Android 登入狀態、瀏覽器會話、安裝套件、模型權重和私人證據不在公共來源分發範圍內。

私人檔案和原始交付標籤保持完好。此來源清理中不會變更裝置帳戶、來賓資料、正在執行的服務或網站部署。故意保留了`admin / admin`出廠預設值；它不是私人憑證。管理員必須在曝光之前對其進行更改。

## 審核和驗證

查看工作樹和正在發布的儲存庫中每個可存取的提交/標籤。使用 Gitleaks 加上 `tools/open_source_sensitive.py`；兩者都不足以證明低熵密碼或個人元資料不存在。使用私有外部拒絕清單來比較已確認的舊私有值，而不是使用已提交的測試裝置。單獨審查剩餘的結果，包括測試文件。

清理檢查包括來源策略、綜合迴歸、配置和語法檢查。他們不會使用發現的憑證登入、重新安裝盒子或重複產品驗收。早期的 API 打包修正（包括共用 UI 來源和僅匯入入口點檢查）保留在來源中。

新克隆不得匯入已停用的提交、引用或標籤。刪除儲存庫不會召回其他人已經下載的副本。任何掃描都無法確定未知憑證從未被複製；實際使用的憑證必須由其操作員輪換。此清理並不聲稱已旋轉它。

請參閱 [RELEASING.md](RELEASING.zh-TW.md) 以了解來源匯出與稽核說明，並參閱 [BUILDING.md](BUILDING.zh-TW.md) 以了解建置的資源。
