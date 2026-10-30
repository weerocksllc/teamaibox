<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../README.zh-TW.md)
<!-- doc-navigation:end -->

# ARM 虛擬計算機運行時

`Public.Dockerfile` 建構了原始 `windows-arm64-ppi` 運行時所需的相同 ARM TPM 物理存在 (PPI) 功能。在根據固定的發布管理器指紋驗證其分離簽章後，它會從官方版本建立 QEMU 11.1.1。 Debian 提供容器庫和工具，而不是用於執行 guest 虛擬機器的 QEMU 執行檔。

請勿用較舊的 QEMU 分發包取代此可執行檔。 Windows 設定檔啟用 `tpm-tis-device,...,ppi=on`；沒有該 ARM 屬性的建置會在韌體啟動之前退出。刪除 `ppi=on`、停用 TPM 或重設來賓的 TPM 不屬於相容修復。

最終的映像建置檢查 ARM TIS PPI 和 PulseAudio 支援並包含匹配的 RAM 幀緩衝 ROM。在 ARM KVM 主機上，捆綁的 `python3 /usr/local/bin/probe-ppi` 執行無磁碟、暫停的 QEMU/TPM 檢查。它不會安裝現有的來賓磁碟或證明 Windows 安裝已完成。必須在明確指定的測試來賓上單獨檢查 Windows 啟動。

對於現有安裝，請使用平台的執行時間更新策略和相符的節點代理程式設定檔映像摘要。保留磁碟、韌體、TPM 身分和狀態。不要僅僅為了修復 Windows 運行時而重新建立來賓或更改正在運行的 Linux 來賓映像。將本地建置的影像記錄為未發布，直到提交並發布其來源變更。

更新時保留已安裝配置的所有權和讀取權限。如果重新建立 Platform API 來載入執行階段更新策略，則也要從其未變更的映像重新建立其網路命名空間依賴項（`node-agent`, `appliance-gateway`, `desktop-proxy`, `desktop-gateway` 和 `maintenance-controller`）。它們必須加入新 API 容器的網路命名空間。這不是來賓、Docker 守護程序或 AI 工作線程重啟。在提交 Windows 啟動操作之前，等待節點的正常身份驗證心跳恢復就緒狀態。
