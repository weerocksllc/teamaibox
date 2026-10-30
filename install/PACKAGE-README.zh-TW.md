<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.zh-TW.md)
<!-- doc-navigation:end -->

# Team AI Box離線安裝包

原始程式碼的許可證位於捆綁的 `LICENSE` 中。第三方元件保留其原始許可證；請參閱 `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`。 MIT 不授予 Google 服務、Windows、模型權重或第三方品牌的額外再分發權利。透過包完整性檢查並不會為每個元件建立重新分發權限。

此軟體包適用於保留相容工廠 Linux 系統的全新 DGX Spark。它使用現有的 Docker、Compose 和 NVIDIA GPU 環境，無需更換或格式化系統磁碟。

## 安裝

使用隨附的 `.sha256` 檔案驗證存檔，然後將其解壓縮：

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

正常安裝既不需要公共互聯網訪問，也不需要手動編輯環境變數。安裝程式提供所需的捆綁工具，產生獨立的本機配置，初始化新資料庫並啟動服務。初始模型載入可能需要一些時間；載入指示器並不能確認安裝成功。

執行`sudo ./install.sh --check`檢查環境和包，無需安裝。 `./install.sh --verify-package`只檢查包內容，也可以在打包工作站上運作。使用 `--installation-root /dedicated/path/installation` 指定新的安裝根目錄；永遠不要將其指向現有資料。

## 中斷和現有數據

發生故障或中斷後，解決報告的問題並重複原始命令。不要刪除安裝目錄。安裝程式保留其產生的身份和資料。重新運行完整的相同版本安裝僅檢查其狀態。其他版本使用正式升級路徑，而不是擦除和重新安裝。沒有強制覆蓋選項。

## 首次使用

開啟設備目前 IP 的 HTTPS 位址並登入：

- 管理員使用者名稱：`admin`
- 初始密碼：`admin`

安裝程式會自動建立該管理員；無需設定令牌提取或手動註冊。初始密碼公開且簡單：出貨/使用前可在使用者管理中變更。普通用戶沒有預設帳戶，由管理員建立。這僅適用於空帳戶資料庫；復原、重新運行、重新啟動和升級永遠不會將現有帳戶或密碼重設為預設值。獨立產生的管理員復原程式碼儲存在安裝根目錄下的 `secrets/initial-owner-recovery.json` 下，只有 root 可讀。切勿將恢復代碼傳送到聊天、票證或公共日誌。現有安裝不會產生或取代恢復代碼。對於本機頒發的HTTPS證書，請根據管理員的CA指令配置瀏覽器信任。憑證中的名稱不保證 LAN DNS/mDNS 解析。本機 CA 公共憑證通常位於 `/srv/teamaibox/installation/https/ca.crt`。僅分發該公共證書，切勿分發其旁邊的私鑰。

安裝不包括現有虛擬機器、Google 登入狀態或使用者檔案。使用者上傳 Windows/Linux ISO 或從團隊磁碟機中選擇它們，然後自行安裝來賓系統。 Google Play 和外部 API 需要互聯網訪問，並且不包含在離線可用性承諾中。

元件許可證文字與其發布資源一起保留。版權所有 © Weerocks LLC。聯絡方式：teamaibox@weerocks.llc。
