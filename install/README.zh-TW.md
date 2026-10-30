<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.zh-TW.md)
<!-- doc-navigation:end -->

# Team AI Box離線打包工具

原始安裝程式已獲得 MIT 許可。軟體包在其文件哈希清單中包含根許可證、第三方清單和許可證文字。這不會將模型、Google 服務、驅動程式或容器相依性重新授權為 MIT。分發前請閱讀[發布邊界](../docs/open-source/RELEASING.zh-TW.md)；現有的完整測試包不會自動獲得重新分發許可。

客戶在準備好的包內運行`sudo ./install.sh`。維護者使用 `build-package.sh` 來建構該軟體包。離線客戶不需要 Git、Node、Go、pip 或公共套件儲存庫。

若要從公共克隆自動下載、建置和安裝，請執行 `sudo bash install/from-source.sh`。中國的網路可以使用`--region cn`。操作、恢復和離線傳輸請參閱[SOURCE-INSTALL.md](SOURCE-INSTALL.zh-TW.md)。支援簡歷；只有最終的就緒結果才能確定安裝完成。成功的預檢或下載還不夠。

目標是一個新的 DGX Spark，其工廠 Ubuntu 24.04 ARM64 系統和工作 Docker 引擎、Compose v2、NVIDIA Container Toolkit/GPU 和 KVM。安裝程式不會取代 Docker/NVIDIA、重新啟動 Docker 或複製開發設備的帳戶、資料庫、金鑰或虛擬機器。

> 私有安裝驗收記錄保留在歷史開發儲存庫中。它們既不是公共來源文件，也不是建置輸入。現有的首次安裝、復原和啟動復原證據不僅僅是為了來源發布而重新運行，並且不限定任意新建的映像或授予第三方二進位檔案的重新分發權利。

## 維護者：準備發布輸入

**對於全新的公共 GitHub 構建，請從 [PUBLIC-BUILD.md](PUBLIC-BUILD.zh-TW.md) 開始。 ** 它涵蓋公共影像、相機運行時、模型下載/量化和韌體，無需來自開發設備的影像。下面的分層影像助理支援已驗證工件的增量更新；它們不是全新建置的先決條件。

準備工作可以使用互聯網。從提供的套件安裝不得下載依賴項。打包主機需要Python 3.10+、PyYAML、Git、Docker、`dpkg-deb`和足夠的儲存空間。模型和圖像可以很大；打包器保留提取的樹和 `.tar`，根據實際輸入估計空間。它既不掃描整個開發設備，也不從正在運行的容器中匯出可寫層。

1. 為所有必要的角色準備 **一個發行版本** 的 ARM64 映像。使用 `deploy/images/`, `deploy/appliance/` 和對應的 guest/model 目錄下的建置入口點。平台API、節點代理、排程器和代理控制器必須支援本機鏡像ID； PostgreSQL 映像必須包含目前遷移清單，包括遷移 116。打包程式不會將任意舊映像編譯為目前映像。透過經過驗證的相同版本父映像，使用 `build_runtime_images.py --bases … --node-agent-binary … --output …` 建立五個後續映像。 `--bases` 是 JSON 角色到完整圖像 ID 映射。首先使用 `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build` 建構節點代理。此幫助器禁止拉取/網路構建，記錄父/來源身份，並在不部署或更改即時標籤的情況下建立新映像。乾淨的 Android ROM 還需要目前的控製網路適配器。使用 `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>` 將 `phone_network.py` 新增至兩個 ROM 後續層，無需網路存取或 ROM 資料變更。它記錄準確的影像 ID 和來源摘要。將 Android sidecar 綁定到兩個新 ID，而不是先前的 ID。使用 `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>` 建立網路和九個官方應用程式。首先依照 `apps/web/package.json` 的指定來建構網路。此幫助程式使用生產 Dockerfile，將 Web 目錄修復為 `/opt/teamaibox/web`，並將映像檔與目前建置輸入雜湊值進行比較。不要假設開發容器映像是完整的 Web 建置：它可能依賴額外的靜態目錄變數或包含舊目錄。此離線助手不會部署。將所有十個新圖像 ID 放入發布輸入中。
2. 收集六個模型的完整、乾淨的目錄：配置、分片、標記器、所需的程式碼和授權。也準備兩個乾淨的 Android 映像、UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` 和繪圖執行時間腳本。請勿收集電話實例目錄、使用者磁碟、Google 登入狀態、使用者 ISO 或全域憑證。 Android ROM 已位於 `phone-runtime` / `phone-google-runtime` 內；不要複製第二個磁碟。 `android-standard` / `android-google` 資產目錄僅包含來源、授權和 `manifest.json`: `schemaVersion: 1`, `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"` or `"google-play"` 和 `runtimeImageId: "sha256:…"`。 ID 必須與匯出的執行時間映像相符。驅動目錄僅包含`virtio.iso`；也包含 `windows.iso` 的開發目錄被拒絕。
3. 建置兩個捆綁的 Linux ARM64 主機工具，而不將它們安裝在建置主機上：

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. 在連接網際網路的 ARM64 建置主機上，使用明確本機 Ubuntu 24.04 映像檔收集主機工具相依性。使用在該主機上驗證的映像 ID，而不是從開發設備複製的 ID：

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   僅收集 cryptsetup、ext4、USB/相機、QEMU 影像工具、網路和小型系統實用程式的依賴項。禁止使用 Docker、containerd、NVIDIA、CUDA 和核心替換套件。安裝僅提供缺少的工具； apt 使用 `--no-download --no-remove` 讀取軟體包的本機檔案儲存庫，無需線上回退。

5. 產生發佈輸入清單並提供**明確工件路徑和本機影像內容 ID**：

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   此範本包含全部 41 個影像角色和 12 個外部資產類別；另一種工廠資產是由工具產生的。佔位符不能輸入包。 `sourceCommit` 必須與結帳相符，`agentVersion` 實際代理版本，以及 `hostPackageCollection` 步驟 4 `collection.json`。建立主機路徑是集合輸入，而不是客戶運行時配置。使用目前工廠產生器：繪圖 UI 的 `drawing.automatic` / `drawing.fast` 路由必須與本機模型組態相符。僅工作人員健康狀況或直接模型呼叫並不能建立應用程式就緒狀態。打包拒絕缺少這些映射的過時工廠模板。

映像角色合約由 `python3 install/package.py --describe-contract` 報告：

- 核心、網路、團隊驅動、訊息傳遞、網關、調度程序、維護、插件、動態代理沙箱和包源網關。
- 九個應用程式外掛程式、六個辦公室模型工作者和按需 ASR/揚聲器運行時間。
- 標準 Android、Google Android、電腦運行時和網路顯示/音訊閘道。
- 廣播接收器、媒體處理和 SFU。

兩個角色可以共享一個圖片內容ID；其存檔僅導出一次。模型分片索引也會被檢查：符合的檔案雜湊值不能成為遺失分片的藉口。主機工具必須是實際的 ARM64 ELF 二進位。

## 建置包

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

輸出是 `teamaibox-<releaseId>-linux-arm64.tar`、其 `.sha256` 檔案和提取的目錄。在發布最終校驗和之前，複製、影像匯出、雜湊和歸檔發生在臨時目錄中。現有輸出不會被覆蓋；中斷的建置一定不能看起來像完整的發布。對於僅安裝程式更改且映像標識未更改，請使用 `--image-cache <previous-extracted-package>`。在透過實際映像 ID 重複使用其檔案之前，會驗證整個舊套件，然後再次驗證新套件。不會從舊安裝或容器可寫層取得任何資料。這可以避免再次導出數百 GB 的相同影像。

正常版本要求其捆綁的來源檔案屬於聲明的 Git 提交。明確的 `--allow-working-tree` 建立開發候選；它的清單記錄了 `candidate: true` 和更改的檔案。透過重點驗收不會將未提交的原始碼轉變為已發布的版本。

封裝佈局：

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

與 `./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64` 獨立驗證。這會檢查完整性；它不能證明在新硬體上成功啟動。

## 客戶：離線安裝與恢復

閱讀[軟體包安裝指南](PACKAGE-README.zh-TW.md)。預設根目錄是 `/srv/teamaibox/installation`。 LUKS/ext4 僅在新的 `volume/data.img` 內部創建，而不是在系統磁碟或現有磁碟上創建。資料池使用可用儲存空間減去實體安全裕度，而不是固定的 256 GiB 限制。模型、業務文件和訪客資料駐留在加密磁碟區中；現有的 Docker 管理容器映像。

全新安裝會建立管理者 `admin`，初始密碼為 `admin`。普通使用者由管理員建立。發貨/使用前請更改初始密碼。這僅適用於空帳戶資料庫：復原、重新運行、重新啟動和升級不會重設現有帳戶或密碼。設備身分、服務憑證、憑證和管理員復原代碼是獨立產生的，而不是從其他設備複製的。初始 GPU 核心快取準備工作使用捆綁的工具和模型在裝置上運行；保留相容的快取。啟動恢復首先恢復資料和設備服務，然後恢復核心服務和單一AI工作人員。安裝程式僅在安裝期間運作；它不會新增常駐安裝程式管理員。

中斷後，重複原來的命令。驗證已完成的步驟；不要透過刪除資料或重新建立容器來隱藏衝突。重新運行已完成的相同版本安裝只會對其進行檢查；不同版本使用正式升級路徑。失敗詳細資料位於安裝根目錄下的 `install-state.json`, `readiness.json` 和階段記錄。

## 驗證邊界

安裝程式特定的測試使用小型結構工件、臨時檔案和隔離的離線資料庫/Docker 守護程式。他們不得存取業務資料庫或掛載現有虛擬機器磁碟。真正的全新安裝需要為此目的明確指定的兼容的 DGX Spark；不要刪除商業設備。驗收涵蓋新安裝的最低啟動、恢復和開機恢復，而不是不相關的業務測試。原始碼發布準備本身不會刪除、重新安裝或部署現有設備。

在建置主機上，執行 `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>` 將完整套件匯入到具有空快取且沒有公用網路的單獨 Docker 守護程式。它不會呼叫全新安裝腳本、使用 GPU、掛載客戶目錄或重新啟動系統 Docker。其報告明確沒有聲稱完整的硬體安裝。測試映像保留在專用的測試目錄中，需要額外的磁碟空間，並且不會進入系統 Docker 的映像儲存。
