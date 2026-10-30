<!-- Generated from docs/readme-locales/ja.json by tools/render-readmes.mjs. -->
# Team AI Box — NVIDIA DGX Spark 向けオープンソースソフトウェア

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

**NVIDIA DGX Spark をチームの AI ワークスペースに。** NVIDIA DGX Spark でローカル AI、画像生成、文書ツールを利用。Team AI Box は共有ファイル、メッセージ、仮想デバイスをブラウザーから使えるオープンソースのワークスペースにまとめます。

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

## Team AI Box を選ぶ理由

- **1 台に集約。** AI、共同作業、仮想デバイスを共通の UI とアカウントで利用できます。
- **ローカル優先。** 推論は Spark で実行。外部モデル API は任意で、USB キーは不要です。
- **DGX Spark 専用設計。** Ubuntu ARM64、NVIDIA GPU コンテナー、KVM を対象とし、開発機固有の設定に依存しません。
- **改良に参加できます。** 自社コードは MIT。UI は 17 言語とライト/ダークテーマに対応し、手動の選択を保存します。初期言語は英語です。

## 実際のワークスペース

日本語 UI の実画面であり、デザインモックではありません。GitHub のテーマに応じて切り替わります。顧客ファイルや認証情報は含みません。モデル出力、ゲスト OS、ユーザー指定名には別の言語設定があります。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/ja/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/ja/workbench-light.jpg">
  <img src="docs/assets/screenshots/ja/workbench-light.jpg" alt="NVIDIA DGX Spark 向け Team AI Box の AI アプリとチームツールの画面 — 日本語" width="1280">
</picture>

[ライト表示](docs/assets/screenshots/ja/workbench-light.jpg) · [ダーク表示](docs/assets/screenshots/ja/workbench-dark.jpg)

## DGX Spark で使うローカル AI とチームアプリ

### AI アシスタント

質問、文章作成・推敲、情報整理、文書処理を対話から行えます。ローカル推論が基本で、外部サービスは選択制です。

### 画像生成

プロンプトから画像を生成・編集し、結果を保存できます。タスクの進捗と出力を確認できます。

### 文字認識

画像や文書から文字とレイアウトを抽出し、確認して再利用できます。

### 音声文字起こし

音声や動画をタイムスタンプ付きのテキストに変換し、議事録や字幕の素材にできます。

### 翻訳

テキストと対応ファイルを翻訳します。対応言語は導入モデルに依存し、UI の言語数とは別です。

### メッセージ

個別チャットやグループで相談し、チームのファイルと一緒に作業できます。メッセージの管理とチャット削除の操作を備えています。

### チームドライブ

ファイルのアップロード、整理、共有、再利用ができます。対応アプリでは保存済みファイルを直接選べます。

### ワイヤレス画面共有

対応する Apple デバイスの画面と音声をブラウザーで視聴し、同僚と共有できます。受信機の検出には適切な LAN 接続が必要です。

### 仮想 Android スマートフォン

ブラウザーからアプリをインストールし、端末の状態を継続利用できます。端末ごとにアプリとデータを保存します。Google サービスは独自の互換性・ライセンス条件に従います。

### Windows / Linux 仮想コンピューター

正規の ARM64 ISO をアップロードまたはドライブから選択し、仮想光学ドライブとディスプレイで OS を自分でインストールできます。起動・再起動画面、音声、閲覧や操作の招待、操作権の交代・共同操作に対応し、所有者は操作権を取り戻せます。リモートデスクトップは追加の方式です。

### チーム管理とタスク状況

一般アカウントとアクセス権を管理し、アプリの準備状況や進捗を確認できます。各アプリは必要な依存サービスが準備でき次第利用可能になります。

## NVIDIA DGX Spark とは？

NVIDIA DGX Spark は GB10 Grace Blackwell Superchip を搭載した小型デスクトップ AI システムです。128 GB 構成は、20 コア Arm CPU、Blackwell GPU、128 GB の統合システムメモリを備え、メモリ帯域幅は 273 GB/s です。NVIDIA の公称理論 AI 演算性能は、スパース性を利用した FP4 精度で最大 1 PFLOP です。

統合メモリは共有システムメモリであり、専用 VRAM ではありません。仕様は構成によって異なり、理論演算性能はアプリの実速度や同時利用人数を保証しません。

DGX Spark が演算能力を提供し、Team AI Box がローカル推論、画像生成、OCR、文字起こし、翻訳、共同作業の共通インターフェースを提供します。ソースからの初回インストールにはダウンロードとビルドが必要で、即時完了を保証するものではありません。

[NVIDIA DGX Spark の公式ハードウェア仕様](https://docs.nvidia.com/dgx/dgx-spark/hardware.html)

Team AI Box は Weerocks LLC の独立したプロジェクトであり、NVIDIA 製品や NVIDIA による認証・推奨を意味しません。本プロジェクトの対応ハードウェアは以下のインストール要件で定義されます。

<a id="install"></a>

## 新しい DGX Spark にインストール

**Ubuntu 24.04 ARM64 の未導入 DGX Spark**、動作する Docker Engine / Compose v2、NVIDIA ドライバーとコンテナー対応、KVM、Git、Python 3.10+ が必要です。モデル・ビルド・パッケージ用に数百 GB の一時空き容量を確保してください。既存の業務データを上書きしないでください。

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

上記を **Spark 上で**実行します。スクリプトはモデルと入力を取得し、ランタイムイメージをビルド、完全なオフラインパッケージを作成してインストールします。初回は通信と時間が必要で、clone だけでは使えません。Docker/NVIDIA 環境は再利用し、開発者のアカウントやディスクはコピーしません。

### 事前確認と再開

`--check` で事前確認できます。中断したら `/var/tmp/teamaibox-source-build` を残し、**同じコマンド**を再実行してください。確認済みのダウンロードと工程を再利用します。キャッシュ削除や並行ビルドは避けてください。既定は公式配布元です。接続できない場合は[インストール説明](install/SOURCE-INSTALL.ja.md)の代替配布元、または検証済みキャッシュ/完全パッケージの転送を使います。ミラーの可用性は保証しません。コード変更後は新しい `--work-dir` を使い、チェックポイントを回避しないでください。

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### インストール後

1. 現在の LAN IP で `https://<BOX_LAN_IP>/` を開き、ローカル生成された証明書が自分の機器のものか確認します。
2. `admin` / `admin` でログインし、**初期パスワードを変更**して一般アカウントを作成します。初期認証情報を公開しないでください。
3. 各 AI アプリの準備完了を待ち、プロフィールから言語とテーマを選びます。準備記録は `/srv/teamaibox/installation/readiness.json` にあります。
4. 仮想 OS 用の正規 ARM64 ISO とライセンスは各自で用意します。オフライン機には先に完全パッケージを準備し、[パッケージ説明](install/README.ja.md)に従います。ソース準備自体はオンラインです。

## ライセンスと制約

独自コードと文書は MIT ですが、**すべてのバイナリーが MIT ではありません**。モデル、第三者コード、NVIDIA、ファームウェア、Google、Windows は個別条件に従います。重み、導入済みゲストディスク、ログイン状態、ISO、インストール包は Git に含みません。Google 互換性は Play Protect 認証ではなく、画面共有は DRM や Apple 認証を含みません。Windows 10 ARM64 の対応は表明しません。性能と同時実行数は負荷と機器次第です。公式サイトは別の非公開リポジトリで、製品 UI は公開対象です。

## 一緒に育てましょう

不具合報告、文書、翻訳、アクセシビリティ、連携、コードを歓迎します。Issue で課題を説明し、fork と作業ブランチを作って関連チェック・画面付きの PR を送ってください。文書や単体部品の改善に Spark は必須ではありません。実機未確認は明記し、秘密情報や個人ファイル、ログイン済みイメージは添付しないでください。脆弱性は SECURITY.md の非公開窓口へ。必須 CLA や有料の参加許可はありません。

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.ja.md) · [SECURITY](SECURITY.ja.md)

## 詳しい資料

- [ソース導入と復旧](install/SOURCE-INSTALL.ja.md)
- [オフラインパッケージ](install/README.ja.md)
- [開発環境とビルド](docs/open-source/BUILDING.ja.md)
- [貢献手順](CONTRIBUTING.ja.md)
- [非公開の安全報告](SECURITY.ja.md)
- [第三者ライセンスと配布範囲](THIRD_PARTY_NOTICES.ja.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [第三者ライセンスと配布範囲](docs/open-source/RELEASING.ja.md)
