<!-- doc-navigation:start -->
[English](SECURITY.md) · [简体中文](SECURITY.zh-CN.md) · [繁體中文](SECURITY.zh-TW.md) · [日本語](SECURITY.ja.md) · [한국어](SECURITY.ko.md) · [Français](SECURITY.fr.md) · [Deutsch](SECURITY.de.md) · [Español](SECURITY.es.md) · [Português](SECURITY.pt-BR.md) · [Русский](SECURITY.ru.md) · [العربية](SECURITY.ar.md) · [हिन्दी](SECURITY.hi.md) · [Bahasa Indonesia](SECURITY.id.md) · [Italiano](SECURITY.it.md) · [Türkçe](SECURITY.tr.md) · [Tiếng Việt](SECURITY.vi.md) · [ไทย](SECURITY.th.md)

[Team AI Box — README](README.zh-TW.md)
<!-- doc-navigation:end -->

# 安全報告

請私下向 **teamaibox@weerocks.llc** 報告可疑漏洞。包括受影響的版本、最小複製、影響和編輯日誌。請勿將憑證、客戶內容或利用細節放在公共問題中。在發送敏感文件之前請求適當的安全傳輸通道。沒有聲稱響應時間保證或獨立安全認證。

新的離線安裝目前使用記錄的引導管理器 `admin` / `admin`；在將裝置暴露給使用者或不受信任的網路之前更改該密碼。這是一個公開的初始憑證，而不是隱藏在掃描器白名單中的秘密。不會自動建立普通使用者帳戶。更改此入職行為不屬於此許可變更範圍。

## 來源/歷史回顧

有關排除的資料、歷史記錄審查和憑證輪替責任，請參閱[公共來源隱私邊界](docs/open-source/SOURCE-PRIVACY.zh-TW.md)。

依照[發布準備](docs/open-source/RELEASING.zh-TW.md)中的說明執行固定的本機掃描器。報告是私密的、經過編輯的，並且絕不會上傳到外部掃描服務。如果真實憑證出現在私人歷史記錄中，則從 HEAD 中刪除並不表示撤銷。與所有者一起撤銷/輪換它；重寫或刪除歷史記錄需要單獨授權。原始交貨標籤不會被移動以進行消毒。

公共來源候選者是不包含 `.git`、私人證據、裝置快照、訪客資料或受限二進位檔案的新檔案匯出。 **不要**簡單地更改此開發存儲庫的可見性或公開推送其舊引用。
