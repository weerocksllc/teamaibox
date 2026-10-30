<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.zh-TW.md)
<!-- doc-navigation:end -->

# 許可範圍和第三方聲明

版權所有 © 2026 Weerocks LLC。根 [MIT 許可證](LICENSE) 涵蓋其所有者授權的原始 Team AI Box 程式碼和文件。它不會重新授權第三方程式碼、複製/修改的上游檔案、依賴項、模型、韌體、作業系統、字型或映像。現有的版權、許可證和通知文件對於各自的資料具有優先權。包元資料 `license: MIT` 指的是該套件的原始程式碼，而不是已部署映像中包含的所有內容。保留 `private: true` 以避免意外的包註冊表發布；它不會撤銷 MIT 授予。

## 庫存

機器可讀的[元件清單](docs/open-source/components.json)記錄版本或版本來源、許可證據、再分發範圍和未解決的二進位義務。 [依賴項清單](docs/open-source/dependencies.json) 是根據鎖定檔案、已安裝的依賴項元資料、Go 模組和 Python 需求檔案產生的。缺少的許可證元資料是明確未知的，不假設 MIT。使用 `python3 tools/open_source_inventory.py` 重新生成它。

|組件/材料|許可邊界|分銷要求|
| ---| ---| ---|
| UxPlay 接收器和 `deploy/casting/uxplay-*.patch` | GPL-3.0-only |保留 GPL、通知、準確的上游原始碼、補丁以及使用任何接收器二進位檔案建置腳本；對於二進位版本不夠來說，僅僅連結到上游是不夠的。 |
| gst-外掛程式-rs / `gst-webrtc-*.patch` | MPL-2.0 |保留通知並提供修改後的涵蓋原始檔。 |
| GStreamer | LGPL 與個人外掛程式授權 |檢查實際外掛程式集並履行相應義務。 |
| LiveKit伺服器/瀏覽器SDK | Apache-2.0 |保留版權、授權和適用的聲明。 |
|墨魚/ AOSP | Apache-2.0 和每個檔案許可證，包括 GPL 核心 |保留上游通知和適用的相應來源。 AOSP 不包含 Google 服務許可。 |
| QEMU / Linux / EDK II / virtio 驅動程式 |每個專案和每個檔案的授權 |審核實際的二進位建置、韌體和驅動程式；不要一攬子標籤MIT。 |
|酪梨醬| Apache-2.0 |保留電腦外掛程式 Dockerfile 複製的許可證和通知。 |
| Node/React/Vite 與 JS 依賴樹 |每包許可證 |分發捆綁輸出時保留依賴通知。 |
| PostgreSQL 和容器作業系統套件 | PostgreSQL / 每個套件 |在二進位版本中包含已安裝的軟體包授權記錄。 |
| OCR 使用的 PyMuPDF / MuPDF | AGPL-3.0-or-later 或商業許可 |組合的 OCR 工作人員分配/服務不是一攬子 MIT；遵守 AGPL 義務或獲得商業權利。原始程式碼可能會保留其 MIT 授權。 |
| Qwen / LMT / Whisper / FLUX 模型資產 |精確模型的條款 |模型與 MIT 來源授權是分開的。 FLUX **4B** 術語不得取代其他 FLUX 模型。 |
|混元OCR權重|騰訊混元社群授權|有條件型號許可證；檢查每個版本的接收者、地區、使用、歸屬和再分發條款。 |
| NVIDIA軟體| NVIDIA 和包含的第三方條款 |現有主機 Docker/NVIDIA 安裝不會透過此來源碼包重新分發。捆綁的 CUDA/容器庫仍然需要自己的審查。 |
|Google行動服務/Play商店|專有|不屬於公共來源候選者的一部分。運行時整合程式碼不授予分發 GMS 映像的權限。 |
| Windows 安裝媒體、來賓磁碟、帳戶 |未涵蓋 |使用者提供授權的 ISO 媒體和授權。切勿運送測試虛擬機器磁碟或登入的來賓狀態。 |
|退役的 ViKey SDK |專有/未設立公共資助 | SDK 從工作來源中刪除；不得發布私有歷史提交和保留的 SDK 副本。不需要 USB 金鑰。 |

確切的選角通知保留在 [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt) 中。 ADB 運輸通知保留在電話用戶端旁邊。縮小或包裝時請勿移除它們。容器隔離本身並不能取消 Copyleft 義務。分佈分析取決於實際的組合工件。

## 品牌和貢獻者

MIT 授予版權許可，而非商標權或認可。 Team AI Box 和 Weerocks 名稱/標誌不得暗示對修改產品的官方支援。 NVIDIA、DGX Spark、Android、Google Play、Windows 和 Apple/AirPlay 屬於各自的擁有者。相容性不是認證。

本地作者元資料是一份清單，而不是版權轉讓的證明。審核的所有權類別記錄在 [OWNERSHIP.md](docs/open-source/OWNERSHIP.zh-TW.md) 中。專案業主的授權適用於其原始出資；貢獻者必須僅提交他們有權獲得許可的作品。疑似缺少歸屬：teamaibox@weerocks.llc。
