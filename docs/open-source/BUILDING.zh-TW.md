<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.zh-TW.md)
<!-- doc-navigation:end -->

# 建構原始碼

公共工件是來源，而不是預先建置的離線設備映像。來源建置可以下載依賴項；使用準備好的完整套件進行安裝仍處於離線狀態。這兩個過程都不需要 ViKey SDK 或 USB 金鑰。

對於完整的設備安裝，請從根[快速啟動](../../README.zh-TW.md#install)和[來源安裝程式](../../install/SOURCE-INSTALL.zh-TW.md)開始：`sudo bash install/from-source.sh`在相容的全新 Spark 上下載、建置、打包和安裝。下面的開發 Web 建置不是安裝程序，也不會啟動完整的產品。

## 發展

使用 Node.js 24、pnpm 11.1.3（請參閱根 `package.json`）、Python 3.10+ 以及每個 `go.mod` 中宣告的 Go 版本（節點代理目前為 1.26）。在建造機器上：

來源匯出故意沒有私有 Git 歷史記錄。在匯出的樹上執行來源工具之前，請初始化您自己的儲存庫並提交您審查的樹 (`git init`, `git add .`, `git commit`)。普通的公共 Git 克隆不需要此步驟。使用新的提交作為建置識別碼；不要聲稱導出的、修改的樹是舊的交付提交。

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

Web 建置是編譯檢查，不是產品驗收。運行時服務使用 `deploy/` 下的 Dockerfile。 DGX Spark執行需要Linux ARM64和現有的NVIDIA/Docker環境。桌面來源簽出並不能取代該硬體。不要使用歷史實驗室腳本作為安裝程序。

Python 工廠建置助理還需要 PyYAML；請參閱安裝程式依賴項預檢。無需安裝作業系統磁碟或開發人員帳戶。

## 排除編譯輸入

匯出器會忽略二進位文件，即使它們的副檔名看起來無害：

- 從 Go 原始碼建置 `services/node-agent` 及其 `cmd/factory-worker-spec` 助理；儲存庫根 `node-agent` 執行檔不是來源輸入。
- 不提供 Android 固定 APK 和簽署檔。它們在 `tools/fixtures/` 下的來源和清單仍然可用於本機測試版本。
- 目前的設備鑄造版本使用 `deploy/appliance/wireless-casting-plugin.Dockerfile`。它不需要舊的 Alpine 包檔案。如果您使用獨立外掛程式 Dockerfile，請取得[其上游校驗和清單](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json) 中標識的確切包，並在建置之前驗證其 SHA-256 值。當固定的上游工件不可用時，切勿替換任意包。
- LiveKit瀏覽器模組及其許可證保留在插件的公共來源目錄中；冗餘的 npm `.tgz` 存檔未提供。

這些是來源分發排除，而不是對正在運行的設備的變更。

## 完整的離線包

從[公共來源管道](../../install/PUBLIC-BUILD.zh-TW.md)開始。它提供公共父映像和來源建置的執行時間相依性；不需要先前的開發人員安裝。歷史分層影像配方不是全新安裝的入口點。

依照 [install/README.md](../../install/README.zh-TW.md) 進行應用程式映像建置、來賓主機工具、離線主機套件、資產收集和最終打包。目標裝置不會取得相依性或取代 Docker/NVIDIA。將建置輸入設定為實際原始碼提交、ARM64 OCI 內容 ID 和乾淨的資產路徑。不需要開發主機 IP、帳戶、憑證或磁碟區。模型權重和來賓/運行時資產是從 [components.json](components.json) 中標識的確切上游來源和儲存庫鎖定中單獨取得的。保留他們的許可證和所需的來源聲明。

**來源可用性不是二進位重新分發授權。 ** 目前完整的離線包合約包括 Google Android 運行時；其私人安裝證據是不允許分發GMS。現有的打包程序保持不變，但除非獲得這些權利，否則此類軟體包不是經過批准的公開下載。僅 AOSP 的公共二進位版本將是單獨範圍的包裝更改，而不是在這裡默默地替換。 Windows/Linux ISO檔案由每個使用者提供；沒有安裝的測試來賓或帳戶狀態是公共建置輸入。
