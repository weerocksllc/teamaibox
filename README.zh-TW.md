<!-- Generated from docs/readme-locales/ and docs/readme-features/zh-TW.json by tools/render-readmes.mjs. -->
# Team AI Box — 專為 NVIDIA DGX Spark 打造的開源軟體

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

**讓 NVIDIA DGX Spark 成為整個團隊的 AI 工作空間。** 在 NVIDIA DGX Spark 上執行本機 AI、圖像生成與文件工具。Team AI Box 將團隊檔案、即時通訊與虛擬裝置整合到一個開源的瀏覽器工作空間。

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

[完整功能清單](#features) · [在全新 DGX Spark 上安裝](#install) · [歡迎一起貢獻](#contribute)

## 為什麼選擇 Team AI Box？

- **單機整合。** AI、協作及虛擬裝置共用一致的介面與帳號體系。
- **本機 AI 優先。** 在 Spark 上執行模型推論，也可按需串接外部模型 API。
- **專為 DGX Spark 打造。** 支援 Ubuntu ARM64、NVIDIA GPU 容器與 KVM 虛擬化。
- **開放共同改進。** 自研程式碼採 MIT；介面支援 17 種語言及明暗主題，記住手動選擇，預設英文。

## 真實工作空間畫面

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/zh-TW/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/zh-TW/workbench-light.jpg">
  <img src="docs/assets/screenshots/zh-TW/workbench-light.jpg" alt="適用於 NVIDIA DGX Spark 的 Team AI Box 工作台，展示 AI 應用與團隊工具 — 繁體中文" width="1280">
</picture>

[淺色畫面](docs/assets/screenshots/zh-TW/workbench-light.jpg) · [深色畫面](docs/assets/screenshots/zh-TW/workbench-dark.jpg)

<a id="features"></a>

## 完整功能清單

**依模組瀏覽**

- [工作台與日常導覽](#feature-workspace)
- [AI 助理與可控的 Agent 工作流程](#feature-assistant)
- [AI 圖片生成](#feature-drawing)
- [文字辨識與校正](#feature-ocr)
- [影音檔案與即時語音轉寫](#feature-transcription)
- [文字、檔案與媒體翻譯](#feature-translation)
- [團隊即時通訊](#feature-messaging)
- [團隊雲端硬碟與檔案協作](#feature-drive)
- [相容 AirPlay 的無線投影](#feature-casting)
- [可保留資料的虛擬 Android 手機](#feature-phones)
- [虛擬 Windows 與 Linux 電腦](#feature-computers)
- [管理、權限與安全](#feature-administration)
- [從原始碼安裝與維護](#feature-installation)
- [開源開發與擴充](#feature-developers)

<a id="feature-workspace"></a>

### 工作台與日常導覽

- 在單一 DGX Spark 上，透過同一個瀏覽器工作空間使用本機 AI、團隊協作及虛擬裝置。
- 依分類瀏覽應用程式、搜尋應用目錄，並從側邊欄開啟應用程式。
- 分別查看各應用程式的載入進度、可用狀態與服務詳情。
- 在任務中心追蹤排隊、執行中、已完成、失敗及已取消的工作，並開啟可用的結果。
- 在通知選單查看待處理的投影邀請，並開啟投影應用程式回應。
- 選擇 17 種介面語言，包括由右至左顯示的阿拉伯語；未手動選擇其他語言時預設為英文。
- 選擇淺色、深色或跟隨系統的外觀；重新整理、再次登入及進入各應用程式後，仍保留手動設定的語言與主題。

<a id="feature-assistant"></a>

### AI 助理與可控的 Agent 工作流程

- 開始對話、儲存歷史紀錄，並重新開啟先前的討論。
- 為目前的請求選擇自動、回答或 Agent 模式。
- 在請求中附加多個檔案，也可在傳送前移除附件。
- 閱讀串流回覆、停止執行中的工作，並在重新連線後繼續接收事件。
- 查看回傳的模型詳情、工具活動、來源與用量；工作產生檔案時，可下載其產物。
- 查看需要確認的 Agent 操作範圍，再個別核准或拒絕該操作。
- Agent 在每位使用者獨立的沙箱中工作，並保留工作空間；工具與網路存取遵循管理員原則。

<a id="feature-drawing"></a>

### AI 圖片生成

- 透過可用的繪圖模型，根據文字提示生成圖片；目前的應用程式不是圖片編輯或局部重繪工具。
- 在可用的模型設定支援時，選擇自動或快速生成方式。
- 選擇正方形、橫向或直向比例、支援的輸出尺寸，以及隨機或固定種子。
- 選擇 PNG、WebP 或 JPEG 輸出，預覽並下載圖片。
- 查看排隊及生成進度、取消工作，並在重新開啟頁面後恢復目前的工作。
- 查看結果記錄的實際模型及生成參數。

<a id="feature-ocr"></a>

### 文字辨識與校正

- 上傳 PNG、JPEG、WebP 或 PDF，或從團隊雲端硬碟選擇現有檔案。
- 提供語言提示，在所選模型支援的範圍內辨識文字、Markdown 表格或 LaTeX 公式。
- 依頁面與文字區塊檢查辨識結果，並手動校正文字。
- 將校對後的內容匯出為文字、Markdown 或 JSON。
- 將已儲存的辨識結果交給翻譯應用程式，無須重新上傳及辨識原始檔案。
- 追蹤或取消辨識工作。目前的模型不提供文字框座標或信心分數。

<a id="feature-transcription"></a>

### 影音檔案與即時語音轉寫

- 選擇本機或雲端硬碟中的影音檔案：WAV、FLAC、OGG、WebM、MP3、M4A、AIFF 或 MP4。
- 預覽原始媒體，使用自動語言偵測或支援的語言提示。
- 查看附時間戳記的轉寫片段，並編輯文字。
- 匯出文字、JSON、SRT 或 WebVTT 字幕。
- 將已儲存的轉寫結果交給翻譯應用程式，並追蹤或取消目前的轉寫工作。
- 在 HTTPS、瀏覽器權限、MediaRecorder 及即時服務皆可用時，即時轉寫麥克風輸入。
- 僅在支援的模型設定下使用詞級時間戳記或說話者分離；實驗性的說話者分離流程需要 WAV 輸入。

<a id="feature-translation"></a>

### 文字、檔案與媒體翻譯

- 從模型支援的 60 種語言目錄中選擇，自動偵測來源語言，或手動選擇、交換來源與目標語言；不保證所有語言組合都有相同的翻譯品質。
- 翻譯輸入或貼上的文字，對照查看原文與譯文片段。
- 上傳圖片或 PDF，或從雲端硬碟選取；OCR 就緒時先辨識其中的文字，再進行翻譯。
- 轉寫服務就緒時，先轉寫再翻譯支援的影音檔案，並保留片段時間資訊。
- 重複利用已儲存的 OCR 或轉寫結果，並下載可用的中間結果。
- 編輯譯文，匯出文字、Markdown 或 JSON；影音結果也支援 SRT 與 WebVTT。
- 查看擷取、轉寫與翻譯各階段的進度，取消工作，並在重新開啟頁面後恢復目前的工作。
- 翻譯語言與介面、OCR、語音轉寫的語言範圍不同。PDF 翻譯以文字為主，不等於重建原始版面或通用 DOCX/XLSX 編輯。

<a id="feature-messaging"></a>

### 團隊即時通訊

- 尋找團隊成員、開始一對一聊天，或選擇成員建立具名稱的群組聊天。
- 篩選全部、未讀或群組聊天，搜尋自己有權存取的會話與訊息。
- 傳送文字及檔案附件，下載附件的原始檔案版本。
- 即時接收訊息、斷線後恢復歷史紀錄、追蹤未讀與已讀位置，並查看成員上線狀態。
- 按 Enter 傳送、Shift+Enter 換行；窄螢幕下可在會話清單與聊天頁面之間切換。
- 從自己的檢視刪除單則訊息，或清空自己的聊天紀錄；不會刪除其他參與者的紀錄。
- 從自己的會話清單刪除聊天，不會退出群組；收到新訊息後，該會話可能再次出現。

<a id="feature-drive"></a>

### 團隊雲端硬碟與檔案協作

- 透過資料夾與路徑導覽，整理個人及團隊檔案空間。
- 切換清單或格狀檢視、查看檔案詳情、搜尋檔案與資料夾，以及查看最近的變更。
- 上傳多個檔案、查看上傳進度或取消上傳。
- 再次選取同一個大型檔案，即可繼續分段上傳；已上傳的區塊由伺服器驗證。
- 建立資料夾，重新命名、移動或複製檔案與資料夾。
- 預覽支援的圖片、音訊、影片、文字及 PDF，並下載檔案；媒體播放取決於瀏覽器支援。
- 上傳檔案的新版本、查看版本紀錄，並下載舊版本。
- 將檔案或資料夾移至資源回收筒，並視需要還原。
- 與成員或團隊進行內部分享，設定檢視、編輯權限及選用的到期時間；不是匿名公開分享連結。
- 瀏覽他人分享的檔案及資料夾，存取時重新確認目前的權限與成員資格。

<a id="feature-casting"></a>

### 相容 AirPlay 的無線投影

- 為同一區域網路內的相容 Apple 裝置啟動或停止臨時接收器，使用獨立的接收器名稱與 PIN。
- 選擇 15、30、60 或 120 分鐘的接收器有效期；停止或到期後，結束廣播及觀看權限。
- 將觀看範圍設為僅自己、指定成員或團隊；邀請觀看者，由其接受或拒絕。
- 在瀏覽器中觀看畫面及播放聲音；瀏覽器的自動播放規則可能要求先點擊才能啟用聲音。
- 查看並移除已連線的觀看者；管理員可停止工作階段，但不會因此獲得觀看私人內容的權限。
- 查看斷線與重新連線狀態，再次加入時重新驗證觀看權限。
- 需要已就緒的媒體服務、可連通的區域網路探索，以及相容的瀏覽器與裝置版本。瀏覽器觀看不提供 HDMI 輸出、DRM/FairPlay 播放或 Apple 認證。

<a id="feature-phones"></a>

### 可保留資料的虛擬 Android 手機

- 使用已安裝的系統設定建立獨立 Android 手機，每台手機的應用程式與資料會跨工作階段保留。
- 分別啟動、關機、重新啟動、重新命名手機，或在明確確認後刪除手機。
- 透過鍵盤、指標，以及返回、主畫面、最近使用的應用程式和音量按鈕操作 Android。
- 使用聲音、全螢幕與重新連線功能，或將目前的手機連線轉移到另一個頁面。
- 將檔案上傳至手機，並從手機的 Team AI Box 檔案交換資料夾下載檔案。
- 確認後安裝自行提供的 APK；不會自動授予 Android 應用程式權限。
- 在支援時，將圖片、影片或瀏覽器攝影機輸入虛擬攝影機；實體 USB 攝影機與網路輸入還需要管理員設定及權限。
- 透過短效中繼，暫時授權指定裝置的 ADB 偵錯，搭配標準 ADB 工具與 Node.js 中繼用戶端。
- 依需要查看影格率、封包遺失及連線往返時間統計；這些數值不是端到端畫面延遲的保證。
- 僅在相應資源可用時選擇 Google Play 系統設定；可用不等於通過 Play Protect 認證，也不保證所有 Android 應用程式都相容。

<a id="feature-computers"></a>

### 虛擬 Windows 與 Linux 電腦

- 建立獨立的 ARM64 Windows/Linux 電腦，選擇 CPU、記憶體與磁碟大小。
- 啟動電腦、正常關機，並在明確確認後刪除已停止的電腦。
- 在瀏覽器中開啟虛擬顯示器，查看韌體、開機、安裝與作業系統畫面，無須先登入遠端桌面。
- 使用鍵盤、指標、聲音、全螢幕及重新連線功能。
- 在多個瀏覽器分頁或視窗中開啟同一台虛擬電腦。
- 邀請團隊成員觀看或控制顯示器，也可撤銷其存取權限。
- 將控制權交給其他參與者、釋放控制權，或由擁有者隨時收回；可選擇單人控制或共同控制模式。
- 上傳安裝 ISO，支援暫停、續傳與取消；也可從個人或團隊雲端硬碟選擇現有 ISO。
- 掛載、退出虛擬光碟，或設定下一次從光碟開機；更換光碟不會自動重新啟動電腦。
- 自行安裝已獲授權的 ARM64 作業系統，並可另外使用遠端桌面。Windows 授權由使用者負責；不包含預先啟用的 Windows，也不提供通用 x86 客體系統支援。

<a id="feature-administration"></a>

### 管理、權限與安全

- 建立本機成員、管理帳號狀態，並在角色允許的範圍內重設密碼。
- 指派內建角色、查看權限、管理團隊成員，並為受保護的擁有者操作提供額外防護。
- 依領域或關聯 ID 篩選稽核事件、查看詳情，並發起稽核歷史完整性驗證。
- 在管理工作台查看盒子、應用程式、儲存空間及執行服務的狀態。
- 設定外部 AI 供應商及模型、操作對應，輪替憑證，並啟用或停用供應商。
- 設定允許的本機或外部路由原則，外部處理需要明確核准；本機 AI 不需要外部 API 金鑰。
- 查看已安裝模型設定、執行環境版本、就緒狀態與驗證詳情。
- 匯入通過驗證的外掛套件，對符合條件的外掛進行安裝、升級、啟停或移除；受保護的官方外掛另有限制。
- 查看執行佇列與工作、調整允許修改的排程原則，並取消符合條件的工作。
- 查看加密儲存與啟動保護設定。自動解鎖使用本機金鑰；啟用開機通關密語需完成復原驗證與確認。

<a id="feature-installation"></a>

### 從原始碼安裝與維護

- 在相容且尚未安裝產品的 DGX Spark 上，複製公開 Git 儲存庫後，執行文件中的單一原始碼安裝命令。
- 自動準備建置工具、下載模型與執行相依項目、建置應用映像、封裝並安裝，沿用現有的 Docker/NVIDIA 環境。
- 使用相同命令與工作目錄繼續中斷的準備流程，重複利用已驗證的下載及已完成的步驟。
- 執行先決條件檢查、僅下載準備，或僅建置安裝套件。
- 預先製作完整的可攜安裝套件，在離線目標機器上安裝；從原始碼準備套件本身仍需要網路。
- 驗證固定版本的建置輸入，必要時使用文件中的替代來源或已驗證的可攜快取；不保證任何第三方鏡像站始終可用。
- 為新盒子產生獨立憑證及文件規定的 admin/admin 初始帳號，之後更改密碼；不複製其他盒子的帳號或客體系統磁碟。
- 查看維護候選項目、相容性結果、明確的執行計畫與歷史紀錄，並依範圍提供回退及復原說明；不是任意作業系統或驅動程式的自動升級。

<a id="feature-developers"></a>

### 開源開發與擴充

- 依 MIT 授權閱讀、修改及重新散布自研產品程式碼與文件；第三方元件保留各自的授權。
- 使用公開 SDK 契約與隨附範例，開發 ApplicationPlugin 或 ComputePlugin 擴充。
- 外掛匯入採用已簽署的套件清單、完整性及權限檢查；不表示已提供公開外掛市集。
- 透過 Issue 與 Pull Request 貢獻修正、翻譯、文件和整合；安全漏洞請使用私密管道通報。

## 什麼是 NVIDIA DGX Spark？

NVIDIA DGX Spark 是採用 GB10 Grace Blackwell 超級晶片的小型桌面 AI 系統。128 GB 配置結合了 20 核心 Arm CPU、Blackwell GPU 與 128 GB 統一系統記憶體，記憶體頻寬為 273 GB/s。NVIDIA 標示的理論 AI 算力最高為 1 PFLOP，採用 FP4 精度與稀疏運算條件。

統一記憶體是共享系統記憶體，不是獨立顯示記憶體。規格因配置而異；理論算力不代表應用程式的實際速度或同時使用人數。

DGX Spark 提供運算能力，Team AI Box 提供團隊共同使用本機推論、圖像生成、文字辨識、轉錄、翻譯與協作工具的統一介面。首次從原始碼安裝需要下載相依套件並建置執行環境。

[NVIDIA DGX Spark 官方硬體規格](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)

Team AI Box 是 Weerocks LLC 的獨立專案，不是 NVIDIA 官方產品，也不表示獲得 NVIDIA 認證或背書。本專案的硬體支援範圍以下方安裝要求為準。

<a id="install"></a>

## 在全新 DGX Spark 上安裝

準備執行 **Ubuntu 24.04 ARM64 的全新 DGX Spark**，具備 Docker Engine、Compose v2、NVIDIA 驅動與容器支援、KVM、Git 及 Python 3.10+。模型、建置及安裝包需要數百 GB 暫存空間，不可覆蓋既有業務資料。

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

在 **Spark 本機**執行上述命令。腳本下載模型與建置輸入、建置映像、製作完整離線包並安裝。首次需連網且耗時；clone 不代表安裝完成。沿用既有 Docker/NVIDIA。

### 預檢與續跑

`--check` 執行預檢。中斷後保留 `/var/tmp/teamaibox-source-build`，重跑**相同命令**，重用已驗證的下載與階段；勿清除快取或重複並行建置。預設官方來源；無法連線時按[安裝文件](install/SOURCE-INSTALL.zh-TW.md)選用替代來源，或搬移經驗證的快取/完整離線包。鏡像站不保證可用。程式碼變更需新 `--work-dir`，可重用 `--cache-dir`，勿跳過檢查點。

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### 安裝之後

1. 以當前區域網路位址開啟 `https://<BOX_LAN_IP>/`，確認本機 HTTPS 憑證屬於自己的裝置。
2. 以 `admin` / `admin` 登入，**立即更改初始密碼**並建立一般帳號，不向公網暴露預設憑證。
3. 等待各應用就緒，在個人選單選語言及主題。
4. 虛擬電腦需自行提供合法 Windows/Linux ARM64 ISO 與授權。離線目標先準備完整安裝包，再依[離線說明](install/README.zh-TW.md)安裝；原始碼準備需連網。

## 授權與邊界

自研程式碼及文件採 MIT，**不涵蓋安裝內所有二進位檔**。第三方程式碼、模型、NVIDIA、韌體、Google 服務與 Windows 保留原條款。倉庫不提供權重、已安裝手機/電腦磁碟、登入狀態、ISO 或離線包。Google 相容不等於 Play Protect 認證；投屏不含 DRM 或 Apple 認證；不宣稱支援 Windows 10 ARM64。效能與並行量取決於硬體及工作負載。

<a id="contribute"></a>

## 歡迎一起貢獻

歡迎問題回報、文件、翻譯、無障礙改善、應用整合及程式碼。先以 Issue 說明使用者問題，再 fork、建立分支及提交 PR，附相關檢查與畫面。改善文件或獨立元件不必擁有 Spark；硬體驗證須如實標註。不要上傳密鑰、個人檔案或已登入映像；安全問題依 SECURITY.md 私下回報。不要求強制 CLA 或付費許可。

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.zh-TW.md) · [SECURITY](SECURITY.zh-TW.md)

## 延伸文件

- [原始碼安裝與復原](install/SOURCE-INSTALL.zh-TW.md)
- [離線包建置與安裝](install/README.zh-TW.md)
- [開發環境與建置](docs/open-source/BUILDING.zh-TW.md)
- [貢獻流程](CONTRIBUTING.zh-TW.md)
- [私密安全回報](SECURITY.zh-TW.md)
- [第三方授權與發行範圍](THIRD_PARTY_NOTICES.zh-TW.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [第三方授權與發行範圍](docs/open-source/RELEASING.zh-TW.md)
