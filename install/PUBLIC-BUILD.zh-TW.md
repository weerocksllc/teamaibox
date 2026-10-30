<!-- doc-navigation:start -->
[English](PUBLIC-BUILD.md) · [简体中文](PUBLIC-BUILD.zh-CN.md) · [繁體中文](PUBLIC-BUILD.zh-TW.md) · [日本語](PUBLIC-BUILD.ja.md) · [한국어](PUBLIC-BUILD.ko.md) · [Français](PUBLIC-BUILD.fr.md) · [Deutsch](PUBLIC-BUILD.de.md) · [Español](PUBLIC-BUILD.es.md) · [Português](PUBLIC-BUILD.pt-BR.md) · [Русский](PUBLIC-BUILD.ru.md) · [العربية](PUBLIC-BUILD.ar.md) · [हिन्दी](PUBLIC-BUILD.hi.md) · [Bahasa Indonesia](PUBLIC-BUILD.id.md) · [Italiano](PUBLIC-BUILD.it.md) · [Türkçe](PUBLIC-BUILD.tr.md) · [Tiếng Việt](PUBLIC-BUILD.vi.md) · [ไทย](PUBLIC-BUILD.th.md)

[Team AI Box — README](../README.zh-TW.md)
<!-- doc-navigation:end -->

# 從公共來源建構一個設備

新的編排入口點記錄在 [SOURCE-INSTALL.md](SOURCE-INSTALL.zh-TW.md) 中。它可以自動執行以下食譜；那裡說明了其完整的設備驗證狀態。這些手動配方仍可供維修人員和各階段的診斷使用。

這是來源到包的路徑。它不會匯入先前的 Team AI Box 安裝、其容器、帳戶、憑證、來賓或資料庫。建置機器需要網路存取；產生的完整包將離線安裝。客戶單獨提供 Windows/Linux 安裝媒體。

使用 Linux ARM64 (Ubuntu 24.04)、Docker/BuildKit、Python 3.10+、PyYAML、jq、Git、Go 1.26 和足夠的磁碟空間下載原始程式碼、建置層和最終的未壓縮套件。模型量化也需要具有足夠可用記憶體的相容 NVIDIA GPU。未經電腦所有者許可，請勿停止其他工作負載來取得該記憶體。 Docker 和 NVIDIA 是先決條件，而不是安裝程式替換的元件。

從新的公共結帳執行命令。將 `BUILD` 設定為結帳 **外部** 的新絕對建置目錄。不得提交輸出、模型和報告。每個助手都會拒絕佔用的輸出，除非它記錄了特定的恢復操作。使用成功報告的引用/ID，而不是從其他人的電腦複製的圖像名稱。本機 Docker 內容 ID 不是可下載的登錄參考； Dockerfile 父參數需要對應的本機標記或合格的上游摘要。

## 1. 服務與應用

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host` 影響線上**建置**，而非安裝的服務網路。節點依賴階段允許每次連線嘗試 2 秒，而不是節點預設的 250 毫秒。這使得官方 npm 下載可在較高延遲的連結（包括用戶管理的 VPN）上使用，而無需切換註冊表、停用 IPv6 或削弱 TLS/套件完整性檢查。此設定是建置階段參數，而不是已安裝應用程式中的環境變更。對於較慢的鏈接，直接 Docker 建置可以覆蓋 `--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`。 Web 映像建立自己的鎖定依賴項和資產。節點服務共享新建置的 API 依賴閉包。 OCR 包括其公共適配器；它不需要來自另一個專案的未發布的工作程序包。翻譯使用固定的公共 NVIDIA vLLM 映像。嵌入、批量 ASR 和投射媒體有意共享各自的公共運行時影像。此電腦映像建置了經過簽署驗證的 QEMU 11.1.1，支援 ARM TPM/PPI、KVM、VNC 和 PulseAudio，保留了原始 Windows 執行時間的功能。 Debian 提供運行時庫，但其較舊的打包 QEMU 不得取代此可執行檔。最終影像檢查 ARM TIS `ppi` 屬性和 PulseAudio 後端，並包含相符的 RAM 幀緩衝區 ROM。有關有界運行時探測和資料保留更新要求，請參閱[虛擬計算機運行時指南](../deploy/windows-computer/README.zh-TW.md)。

每個角色都有一個日誌。失敗的報告保留成功的角色輸出；僅建立失敗的角色並稍後合併成功的報告。不要將正在運行的開發容器替換為遺失的映像。

## 2. 無帳戶 Android 和相機運行時

這些鎖鎖定了 Google 的 AOSP 建置、主機包、核心輸入和原始碼修訂。使用前會檢查下載內容。組裝期間不會啟動任何來賓。

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

對於相機 APK 補丁，請安裝 Google 的公共 Android 命令列工具、平台 `android-36.1`、建置工具 `36.1.0` 和支援 Java 版本的 JDK
8. 將 `ANDROID_SDK_ROOT` and `JDK_HOME` 設定為這些工具目錄。這些工具是建置依賴項，而不是匯出的 Android 使用者設定檔。在 ARM64 Linux 上，Google 捆綁的 `zipalign` 可能僅限 x86：安裝 Ubuntu 的 ARM64 `zipalign` 軟體包並傳遞下面的 `--zipalign /usr/bin/zipalign`。 D8 和 apksigner 是 Java 程式。 APK 建置也可以在單獨的支援的 SDK 主機上運作；僅傳輸其兩個輸出檔案 (`Camera2.apk`, `camera-preview.json`)，而絕不會傳輸該主機的 Android 設定或使用者設定檔。

從乾淨的 AOSP 建置中提取庫存 APK（輸出目錄必須存在並且可由建置容器寫入）：

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

APK 保留已知的**公共 AOSP 測試簽署者**，而不是私有產品金鑰。幫助程式驗證原始憑證和產生的憑證以及未變更的 APK 資源，並刪除臨時簽名資料。這不是帳戶或 Google 裝置身分。

目前完整的安裝程式合約還包括一個實驗性的 Google Android 變體。其公共輸入鎖和簽名檢查**不**授予Google認證或再分發權利。僅在適用的第三方條款內建置/使用它；請勿將生成的完整捆綁包發佈為不受限制的 MIT 下載。

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. Publisher 模型文件與公共量化配方

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

所有模型下載都使用 `deploy/compute/*profile*` 中的不可變修訂版和發布者的 Git/LFS 雜湊。可選的 `--cache <directory>` 是唯讀的，僅當檔案的位元組與發布者相符時才接受檔案。這不是一種隨意匯入已安裝模型目錄的方法。 ASR 的獨立 MIT 文字固定到原始 Whisper 版本，因為轉換後的模型快照僅聲明許可證。 OCR 保留自己的許可證，而不是 MIT。固定的翻譯和嵌入模型卡聲明 Apache-2.0 而不傳送其獨立文本；他們的助手包括校驗和固定的 Apache 許可證以及檢查該聲明後的出處記錄。

中斷的匹配下載支援 `--resume`。 `--transfer ranges` 使用有界可恢復 HTTP 範圍； `--transfer huggingface` 需要官方的 `huggingface_hub`/`hf_xet` 軟體包並停用令牌使用。部分和下載快取保留在可發布模型目錄之外。每次傳輸都強制執行校驗和。不要削弱它們的 HTML 登入/挑戰頁面或截斷的下載。

量化使用 ModelOpt 的公共合成校準資料在單獨的建造容器中離線運行，從不聊天歷史記錄。只有 `build.json` 為 `quantized` 的輸出才能提供 `assistant-model` and `translation-model`；選擇它們的 `model/` 子目錄，而不是原始來源或整個建置工作區。驗證輸入後，Linux 建置建議內核釋放這些特定檔案的快取頁面。這可以避免 GB10 共享記憶體上立即釋放的 GPU 記憶體讀數產生誤導；它不會刪除權重、清除主機範圍的快取或停止工作負載。對於一個 GB10 GPU，助手從 Linux `MemAvailable` 進行預算，並為校準和主機預留容量。它拒絕容量不足，而不是默默地接受以 CPU 為主的建置。當完整模型適合時，明確的 ModelOpt 預算可以避免 Accelerate 不必要的 CPU 卸載匯出路徑。建置容器也遵循 [NVIDIA 的量化啟動要求](https://build.nvidia.com/spark/nvfp4-quantization/instructions) 設定無限鎖定記憶體和 64 MiB 堆疊。這些設定的範圍僅限於建置容器，而不是主機範圍的限制。

## 4. 完整的套件輸入

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

合併必須報告 **41 個角色，並且沒有缺少的角色**。它驗證圖像架構/內容 ID 並拒絕衝突的輸出。資源僅包含上游 UEFI 韌體（包括新的變數儲存範本）、校驗和固定的 virtio 驅動程式 ISO、來源繪圖執行時間以及綁定到新映像的 Android 通知。 ISO 不是 Windows 安裝媒體。其校驗和相同的 Microsoft OpenVMM 映像避免依賴互動式 Fedora 下載頁面。

依照 [README.md](README.zh-TW.md) 中的說明使用 `collect_host_packages.py` 收集主機包，然後使用 `prepare-release.py --template` 產生模板。從`images.json`填充其圖像映射；填充模型輸出 `resources/assets.json` and `guest-tools` 中的所有 12 個資產角色。將 `sourceCommit` 設定為結帳版本和實際代理程式版本。不接受佔位符或先前的安裝配置。

執行 `prepare-release.py --inputs … --output …`，然後使用準備好的版本執行 `build-package.sh`。修改/未提交的來源需要明確的 `--allow-working-tree` 候選標誌；它們不是已發布的提交。請參閱[PACKAGE-README.md](PACKAGE-README.zh-TW.md)進行安裝。新的空白帳戶資料庫取得`admin/admin`；所有服務憑證和裝置身分都是獨立產生的。單獨建造並不能證明安裝成功。

## 歷史分層配方和出版物檢查

保留較舊的診斷/分層 Dockerfile 用於原始碼維護，不被此管道使用。他們的 `BUILD_PARENT_N` 參數故意沒有私有圖像預設值。提供您建置的相容父級，或使用上面的公共管道；不要猜測不可用的開發摘要。

在發布之前，運行來源防護和秘密掃描器，單獨查看歷史記錄，並排除所有建置目錄、套件、來賓磁碟、帳戶資料和私人網站。包含本地路徑的報告屬於公共樹之外。這項工作的驗證僅限於建立輸入閉包、工件身份、安裝和新安裝的最小服務路徑；不重新辦理無關業務受理。
