<!-- doc-navigation:start -->
[English](SOURCE-INSTALL.md) · [简体中文](SOURCE-INSTALL.zh-CN.md) · [繁體中文](SOURCE-INSTALL.zh-TW.md) · [日本語](SOURCE-INSTALL.ja.md) · [한국어](SOURCE-INSTALL.ko.md) · [Français](SOURCE-INSTALL.fr.md) · [Deutsch](SOURCE-INSTALL.de.md) · [Español](SOURCE-INSTALL.es.md) · [Português](SOURCE-INSTALL.pt-BR.md) · [Русский](SOURCE-INSTALL.ru.md) · [العربية](SOURCE-INSTALL.ar.md) · [हिन्दी](SOURCE-INSTALL.hi.md) · [Bahasa Indonesia](SOURCE-INSTALL.id.md) · [Italiano](SOURCE-INSTALL.it.md) · [Türkçe](SOURCE-INSTALL.tr.md) · [Tiếng Việt](SOURCE-INSTALL.vi.md) · [ไทย](SOURCE-INSTALL.th.md)

[Team AI Box — README](../README.zh-TW.md)
<!-- doc-navigation:end -->

# 從公共克隆安裝

此入口點準備所需的公共輸入，建立應用程式映像並在安裝之前產生完整的套件。建置進度可恢復；只有最終的安裝就緒結果顯示設備已安裝。僅下載或預檢成功並不重要。

將產生的模型、容器鏡像、安裝套件、測試記錄和憑證保留在儲存庫之外。不保證第三方鏡像的可用性；已驗證的便攜式快取和離線包如下所述。

在執行 Ubuntu 24.04、執行 Docker/Compose、NVIDIA 和 KVM 的新 DGX Spark 上，複製公共儲存庫並從其根目錄執行：

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

對於無法到達上游模型/影像端點的中國大陸網絡，請使用與區域下載來源相同的入口點：

```sh
sudo bash install/from-source.sh --region cn
```

這是**在線來源建置然後離線安裝**，而不是離線來源建置。它會自動準備缺少的建置工具，下載六個模型輸入，建立和組裝 Android 和所有應用程式映像，量化兩個來源模型，收集韌體/主機包，創建完整的離線包並運行其現有安裝程式。它不會取代 Docker/NVIDIA、重新啟動 Docker 守護程式、清除現有安裝或更改主機路由、DNS 或 VPN 設定。模型、訪客登入狀態和私人行銷網站不是從其他安裝中取得的。

預設工作空間為`/var/tmp/teamaibox-source-build`；下載快取和每階段日誌都位於克隆之外。安裝預設為 `/srv/teamaibox/installation`。預計會有大量下載和數百 GB 的臨時磁碟使用量。模型載入和 GPU 量化可能需要大量時間；沒有承諾固定的完成時間。

## 斷點續跑與狀態

如果中斷，**重新運行完全相同的命令**。保留工作空間。正在運行的建置排除了另一個編寫器；已完成的階段檔案和映像在重新使用之前經過驗證。失敗的嘗試仍可用於診斷，而下一次嘗試僅運行失敗的階段。保留模型位元組範圍和經過驗證的文件。 `state.json` 標識目前階段及其日誌目錄。官方模型下載使用有界文件/範圍並發；區域源使用保守的並發來減少速率限制。每個檔案的位元組進度報告與最終發布者雜湊驗證分開傳輸或重複使用範圍。來賓工具編譯也可以在沒有登入主頁的系統服務下運作：它在產生的安裝資產之外會建立隔離的建置快取。

來源變更需要新的 `--work-dir`；使用 `--cache-dir /path/to/public-cache` 重複使用下載快取。來源指紋可防止悄悄組合不同程式碼的輸出。現有安裝並不邀請重置它：只有此工作區的相同軟體包安裝可以恢復；其他安裝必須使用其升級過程。

有用的模式：

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh --region cn --download-models-only
sudo bash install/from-source.sh --region cn --build-only
```

`--check` 是唯讀的，並沒有聲明下載會成功。僅下載和僅建置明確不聲明已安裝就緒。

## 區域來源與完整性

中國模式使用 `https://hf-mirror.com` 進行模型傳輸，使用 `https://docker.m.daocloud.io` 進行摘要固定的 Docker Hub 輸入。這些是第三方鏡像，而不是 Weerocks 或模型發布者所經營的服務。 Git 提交模型由產品設定檔固定；其經過驗證的 Git 樹和 LFS 指標確定了預期的檔案大小和雜湊值。鏡像的 API 回應本身無法建立信任。 Docker 驗證固定的清單/層摘要。未固定的標籤不會自動重定向（Go 建置工具具有明確摘要鎖定）。 NVIDIA 映像保留在其發布者的註冊表中。 TLS 驗證保持啟用狀態，並且不會將帳戶令牌傳送到模型鏡像。

您可以使用 `--model-endpoint` 和 `--registry-mirror` 來選擇您自己的 HTTPS 來源。端點值不得包含憑證或查詢參數。作用域 Docker 包裝器僅適用於此建置流程，不適用於系統守護程式或其他專案。 SDK元資料和許可證檔案仍然來自其權威的HTTPS發布者；鏡子無法發明雜湊值。

鏡像可能受到速率限製或不可用。模型下載以有限並發運行並尊重冷卻時間。沒有任何腳本可以保證與每個網路上的每個上游的連接。如果這兩種途徑都無法使用，請在可存取的相容電腦上準備下載或完整套件並將其複製到：

- `--download-models-only --cache-dir <public-cache>` 準備經過驗證的模型檔案和可恢復的快取。複製該目錄，然後將其與目標上的 `--cache-dir` 一起傳遞。每個重複使用的模型都會根據其固定身份進行檢查。此快取**不是**完整的離線安裝包。
- `--build-only` 準備離線安裝的完整套件。複製其 tar 和校驗和，驗證並解壓縮，然後在其中運行 `sudo ./install.sh`。這是可靠的斷開主機路由；它不需要目標上有 VPN 或存取開發盒。

切勿複製即時 Docker 資料目錄、來賓磁碟、瀏覽器設定檔、帳戶資料庫、憑證或私人快取來取代公用輸入。不要停用校驗和或接受登入/挑戰頁面作為模型檔案。

## 授權和首次使用

在建置之前，請先查看 `THIRD_PARTY_NOTICES.md`、Android SDK 條款和各個模型許可。下載第三方元件不會將其轉換為 MIT 資產或授予 Google 認證/再分發權利。 Windows/Linux ISO 媒體仍由使用者提供。工廠登入仍然是`admin/admin`；在暴露設備之前更換它。現有安裝程式產生獨立的服務憑證並報告實際準備。

完成後，在同一區域網路內開啟`https://<BOX_LAN_IP>/`；取代 Spark 目前的實體網路位址，而不是 Docker 橋接器或 VPN 位址。來源工作區的 `state.json` 記錄建置進度。已安裝的`/srv/teamaibox/installation/readiness.json`記錄安裝檢查。成功的編譯和偵聽容器運行狀況檢查都不能取代應用程式的可見端對端操作。

投射運作時必須包含 UxPlay 接收器、私有 D-Bus 和 Avahi 發現執行檔及其媒體外掛程式。最終的公共鏡像建置會檢查這些可執行檔；只有客戶端庫是不夠的。全新安裝會將桌面代理程式和網關註冊到其他 API 網路命名空間依賴項，以便分組 API 升級可以保留桌面連線路徑。在維護期間請勿僅重新建立該群組的子集。
