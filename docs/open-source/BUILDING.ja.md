<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.ja.md)
<!-- doc-navigation:end -->

# ソースをビルドする

パブリック アーティファクトはソースであり、事前に構築されたオフライン アプライアンス イメージではありません。ソース ビルドでは依存関係をダウンロードする場合があります。準備された完全なパッケージを使用したインストールはオフラインのままです。どちらのプロセスも ViKey SDK や USB キーを必要としません。

アプライアンスを完全にインストールするには、ルート [クイック スタート](../../README.ja.md#install) および [ソース インストーラー](../../install/SOURCE-INSTALL.ja.md) から開始します。 `sudo bash install/from-source.sh` は、互換性のある新しい Spark にダウンロード、ビルド、パッケージ化してインストールします。以下の開発 Web ビルドはそのインストーラーではないため、完全な製品は起動しません。

## 開発

Node.js 24、pnpm 11.1.3 (ルート `package.json` を参照)、Python 3.10 以降、および各 `go.mod` で宣言されている Go バージョン (現在ノードエージェントは 1.26) を使用します。ビルド マシン上:

ソース エクスポートには意図的にプライベート Git 履歴がありません。エクスポートされたツリーでソース ツールを実行する前に、独自のリポジトリを初期化し、レビューしたツリー (`git init`, `git add .`, `git commit`) をコミットします。通常のパブリック Git クローンでは、この手順は必要ありません。その新しいコミットをビルド ID として使用します。エクスポートされ、変更されたツリーが古い配信コミットであると主張しないでください。

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

Web ビルドはコンパイル チェックであり、製品の受け入れではありません。ランタイム サービスは、`deploy/` の Dockerfile を使用します。 DGX Spark の実行には、Linux ARM64 と既存の NVIDIA/Docker 環境が必要です。デスクトップ ソース チェックアウトは、そのハードウェアに代わるものではありません。過去のラボ スクリプトをインストーラーとして使用しないでください。

Python ファクトリ ビルド ヘルパーにはさらに PyYAML が必要です。インストーラーの依存関係のプリフライトを参照してください。インストールされたオペレーティング システム ディスクや開発者アカウントは必要ありません。

## コンパイル済み入力を除外する

エクスポータは、拡張子が無害に見える場合でも、バイナリ ファイルを省略します。

- Go ソースから `services/node-agent` とその `cmd/factory-worker-spec` ヘルパーをビルドします。 repository-root `node-agent` 実行可能ファイルはソース入力ではありません。
- Android フィクスチャ APK と署名ファイルは同梱されていません。 `tools/fixtures/` の下のソースとマニフェストは、引き続きローカル テスト ビルドで利用できます。
- 現在のアプライアンスのキャスト ビルドは `deploy/appliance/wireless-casting-plugin.Dockerfile` を使用します。古い Alpine パッケージ アーカイブは必要ありません。代わりにスタンドアロン プラグイン Dockerfile を使用する場合は、[アップストリーム チェックサム マニフェスト](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json) で特定された正確なパッケージを取得し、ビルドする前に SHA-256 値を確認してください。ピン留めされたアップストリーム アーティファクトが使用できない場合は、任意のパッケージを決して置き換えないでください。
- LiveKit ブラウザ モジュールとそのライセンスは、プラグインのパブリック ソース ディレクトリに残ります。冗長な npm `.tgz` アーカイブは出荷されません。

これらはソース配布の除外であり、実行中のアプライアンスに対する変更ではありません。

## 完全なオフライン パッケージ

[パブリック ソース パイプライン](../../install/PUBLIC-BUILD.ja.md) から始めます。これは、公開親イメージとソース構築されたランタイム依存関係を提供します。以前の開発者インストールは必要ありません。過去のレイヤード イメージ レシピは、新規インストールのエントリ ポイントではありません。

アプリケーション イメージのビルド、ゲスト ホスト ツール、オフライン ホスト パッケージ、アセットの収集、最終的なパッキングについては、[install/README.md](../../install/README.ja.md) に従ってください。ターゲット アプライアンスは依存関係を取得したり、Docker/NVIDIA を置き換えたりしません。ビルド入力を実際のソース コミット、ARM64 OCI コンテンツ ID、およびクリーンなアセット パスに設定します。開発ホストの IP、アカウント、証明書、ボリュームは必要ありません。モデルの重みとゲスト/ランタイム アセットは、[components.json](components.json) とリポジトリ ロックで特定される正確なアップストリーム ソースから個別に取得されます。ライセンスと必要な出典通知を保存してください。

**ソースの可用性は、バイナリの再配布許可ではありません。** 現在の完全なオフライン パッケージ契約には、Google Android ランタイムが含まれています。その個人的なインストールの証拠は、GMS の配布を許可するものではありません。既存のパッケージャーは変更されずに保持されますが、そのようなパッケージは、それらの権利を取得しない限り、承認されたパブリック ダウンロードではありません。 AOSP のみのパブリック バイナリ エディションは、個別に範囲を定めたパッケージ変更となり、ここで暗黙的に置き換えられるわけではありません。 Windows/Linux ISO ファイルは各ユーザーによって提供されます。インストールされていないテスト ゲストまたはアカウントの状態はパブリック ビルド入力です。
